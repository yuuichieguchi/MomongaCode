import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { MessagePort, isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';
import { openDatabase } from '@momonga/foundation/sqlite';
import { REPOSITORY_FACTS_EVENT_TYPES, createRepositoryFactsFold } from '@momonga/memory';
import { createJournalReader } from '@momonga/store';
import { PERMISSION_MODES } from '@momonga/protocol';
import type { Capabilities, PermissionMode, RunEventPayload } from '@momonga/protocol';
import type { JournalReader } from '@momonga/store';
import { contributionAtTerminal } from './contribution.ts';
import { EVIDENCE_EVENT_TYPES, createEvidenceFold } from './evidence-fold.ts';
import { JOURNAL_PROGRESS_INTERVAL_MS } from './journal-thread-limits.ts';
import { createProgressGate } from './progress-gate.ts';
import { REFLECTION_INPUT_EVENT_TYPES, createReflectionInputFold } from './reflection-input.ts';

export const openJournalConnection = (databasePath: string): ReturnType<typeof openDatabase> => {
  const db = openDatabase(databasePath);
  try {
    db.exec('PRAGMA query_only = ON');
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
};

export type JournalRequest = Readonly<Record<string, unknown>>;
export type JournalReplyFields = Readonly<Record<string, unknown>>;
export type JournalHandler = (request: JournalRequest, progress: () => void) => JournalReplyFields | Promise<JournalReplyFields>;

export type JournalChannel = {
  readonly incoming: { on(event: 'message', listener: (message: unknown) => void): unknown };
  readonly outgoing: { postMessage(message: unknown): void };
};

const requestOf = (message: unknown): { readonly id: number; readonly kind: string; readonly request: JournalRequest } => {
  const request = message as { id?: unknown; kind?: unknown };
  if (typeof request.id !== 'number' || typeof request.kind !== 'string') throw new TypeError('journal thread request must carry a numeric id and a string kind');
  return { id: request.id, kind: request.kind, request: request as JournalRequest };
};

const codeOf = (error: Error & { code?: unknown }): string | undefined => (typeof error.code === 'string' ? error.code : undefined);

const errorOf = (error: unknown): { name: string; message: string; code?: string } => {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const code = codeOf(error);
  return { name: error.name, message: error.message, ...(code === undefined ? {} : { code }) };
};

export const serveJournalReader = (handlers: Readonly<Record<string, JournalHandler>>, { incoming, outgoing }: JournalChannel): void => {
  incoming.on('message', (message: unknown) => {
    const { id, kind, request } = requestOf(message);
    const handler = Object.hasOwn(handlers, kind) ? handlers[kind] : undefined;
    if (handler === undefined) {
      outgoing.postMessage({ id, ok: false, error: { name: 'JournalThreadRequestError', message: `unknown journal thread request kind ${JSON.stringify(kind)}` } });
      return;
    }
    let progressed = 0;
    const progress = (): void => {
      progressed += 1;
      outgoing.postMessage({ id, progress: progressed });
    };
    void (async () => {
      try {
        outgoing.postMessage({ ...(await handler(request, progress)), id, ok: true });
      } catch (error) {
        outgoing.postMessage({ id, ok: false, error: errorOf(error) });
      }
    })();
  });
};

type JournalThreadData = { readonly databasePath: string; readonly port: MessagePort };

const isJournalThreadData = (value: unknown): value is JournalThreadData =>
  typeof value === 'object' && value !== null && typeof (value as { databasePath?: unknown }).databasePath === 'string' && (value as { port?: unknown }).port instanceof MessagePort;

const identityOf = (databasePath: string): { readonly dev: number; readonly ino: number } => {
  const { dev, ino } = fs.statSync(databasePath);
  return { dev, ino };
};

const leadingOf = (value: unknown): RunEventPayload[] => {
  if (!Array.isArray(value) || value.some((event) => typeof event !== 'object' || event === null || typeof (event as { type?: unknown }).type !== 'string')) {
    throw new TypeError('a contribution request must carry its leading events as a list of events');
  }
  return value as RunEventPayload[];
};

export const contributionHandler = (reader: JournalReader, current: { progress: (() => void) | undefined }): JournalHandler => (request, progress) => {
  const { runId, leading } = request;
  if (typeof runId !== 'string') throw new TypeError('a contribution request must carry the id of its run');
  current.progress = progress;
  try {
    const measured = reader.measure(contributionAtTerminal, { runId, leading: leadingOf(leading) });
    return measured.contribution === undefined ? { lastSeq: measured.lastSeq } : { lastSeq: measured.lastSeq, items: measured.contribution.items };
  } finally {
    current.progress = undefined;
  }
};

const textOf = (request: JournalRequest, key: string, kind: string): string => {
  const value = request[key];
  if (typeof value !== 'string') throw new TypeError(`a ${kind} request must carry ${key} as a string`);
  return value;
};

const textsOf = (request: JournalRequest, key: string, kind: string): string[] => {
  const value = request[key];
  if (!Array.isArray(value)) throw new TypeError(`a ${kind} request must carry ${key} as a list of strings`);
  const texts: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new TypeError(`a ${kind} request must carry ${key} as a list of strings`);
    texts.push(item);
  }
  return texts;
};

const isCapabilities = (value: unknown): value is Capabilities =>
  typeof value === 'object' && value !== null && typeof (value as { contextWindow?: unknown }).contextWindow === 'number' && typeof (value as { maxOutputTokens?: unknown }).maxOutputTokens === 'number';

type VisitingReader = Pick<JournalReader, 'visitRun'>;

export const verdictHandler = (reader: VisitingReader): JournalHandler => (request) => {
  const runId = textOf(request, 'runId', 'verdict');
  const fold = createRepositoryFactsFold({ commands: textsOf(request, 'commands', 'verdict'), manifests: textsOf(request, 'manifests', 'verdict') });
  const run = reader.visitRun(runId, REPOSITORY_FACTS_EVENT_TYPES, fold.add);
  const { verified, facts } = fold.finish(run.status);
  return { lastSeq: run.lastSeq, verified, facts };
};

export const evidenceHandler = (reader: VisitingReader): JournalHandler => (request) => {
  const runId = textOf(request, 'runId', 'evidence');
  const { onlyCommand } = request;
  if (onlyCommand !== undefined && typeof onlyCommand !== 'string') throw new TypeError('an evidence request must carry onlyCommand as a string when it carries one');
  const fold = createEvidenceFold({ paths: textsOf(request, 'paths', 'evidence'), verificationCommands: textsOf(request, 'verificationCommands', 'evidence'), onlyCommand });
  const run = reader.visitRun(runId, EVIDENCE_EVENT_TYPES, fold.add);
  return { lastSeq: run.lastSeq, ...fold.finish() };
};

export const reflectionInputHandler = (reader: VisitingReader): JournalHandler => (request) => {
  const runId = textOf(request, 'runId', 'reflection_input');
  const { capabilities } = request;
  if (!isCapabilities(capabilities)) throw new TypeError('a reflection_input request must carry the capabilities of the reflection model');
  const fold = createReflectionInputFold(textOf(request, 'project', 'reflection_input'), capabilities);
  const run = reader.visitRun(runId, REFLECTION_INPUT_EVENT_TYPES, fold.add);
  return { lastSeq: run.lastSeq, input: fold.finish() };
};

const numberOf = (request: JournalRequest, key: string, kind: string): number => {
  const value = request[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`a ${kind} request must carry ${key} as a number`);
  return value;
};

const modeOf = (value: unknown, kind: string): PermissionMode => {
  const mode = PERMISSION_MODES.find((candidate) => candidate === value);
  if (mode === undefined) throw new TypeError(`a ${kind} request must carry a permission mode`);
  return mode;
};

type PlanningReader = Pick<JournalReader, 'planInheritance'>;

type WindowReader = Pick<JournalReader, 'readInheritedWindow'>;

export const inheritPlanHandler = (reader: PlanningReader): JournalHandler => (request) =>
  reader.planInheritance({ runId: textOf(request, 'runId', 'inherit_plan'), mode: modeOf(request['mode'], 'inherit_plan') });

export const inheritedWindowHandler = (reader: WindowReader): JournalHandler => (request) =>
  reader.readInheritedWindow({
    runId: textOf(request, 'runId', 'inherited_window'),
    windowTokens: numberOf(request, 'windowTokens', 'inherited_window'),
    floorTokens: numberOf(request, 'floorTokens', 'inherited_window'),
  });

const withProgress = (current: { progress: (() => void) | undefined }, handler: JournalHandler): JournalHandler => (request, progress) => {
  current.progress = progress;
  try {
    return handler(request, progress);
  } finally {
    current.progress = undefined;
  }
};

const serve = (data: JournalThreadData): void => {
  if (parentPort === null) throw new Error('journal thread has no parent port');
  const before = identityOf(data.databasePath);
  const db = openJournalConnection(data.databasePath);
  const after = identityOf(data.databasePath);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    db.close();
    throw new Error(`database file ${data.databasePath} was replaced while the journal thread opened it`);
  }
  const current: { progress: (() => void) | undefined } = { progress: undefined };
  const gate = createProgressGate({ now: () => performance.now(), intervalMs: JOURNAL_PROGRESS_INTERVAL_MS, post: () => current.progress?.() });
  const reader = createJournalReader(db, { unit: gate.unit });
  serveJournalReader(
    {
      ping: () => ({ threadId }),
      contribution: contributionHandler(reader, current),
      verdict: withProgress(current, verdictHandler(reader)),
      evidence: withProgress(current, evidenceHandler(reader)),
      reflection_input: withProgress(current, reflectionInputHandler(reader)),
      inherit_plan: withProgress(current, inheritPlanHandler(reader)),
      inherited_window: withProgress(current, inheritedWindowHandler(reader)),
    },
    { incoming: parentPort, outgoing: data.port },
  );
  parentPort.on('close', () => db.close());
  data.port.postMessage({ ready: true, dev: after.dev, ino: after.ino });
};

if (!isMainThread && isJournalThreadData(workerData)) serve(workerData);
