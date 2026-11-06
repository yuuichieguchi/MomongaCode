import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { MessagePort, isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';
import { openDatabase } from '@momonga/foundation/sqlite';
import { REPOSITORY_FACTS_EVENT_TYPES, createRepositoryFactsFold } from '@momonga/memory';
import { FactsRefusedError, createBlobStore, createJournalReader } from '@momonga/store';
import { FIDELITY_CLAIMS, MAIN_AGENT, PERMISSION_MODES } from '@momonga/protocol';
import { FACTS_EVENT_TYPES, createCallsFold, createFactsFold } from '@momonga/reliability';
import type { Capabilities, ClaimedToken, PermissionMode, RunEvent, RunEventPayload, RunFactsLimits } from '@momonga/protocol';
import type { DatabaseSync } from 'node:sqlite';
import type { BlobStore, JournalReader } from '@momonga/store';
import { contributionAtTerminal } from './contribution.ts';
import { EVIDENCE_EVENT_TYPES, createEvidenceFold } from './evidence-fold.ts';
import { FIDELITY_EVENT_TYPES, createFidelityFold } from './fidelity-fold.ts';
import type { FidelityFold } from './fidelity-fold.ts';
import { FIDELITY_SCAN_PAGE_BYTES, JOURNAL_PROGRESS_INTERVAL_MS } from './journal-thread-limits.ts';
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

const errorOf = (error: unknown): { name: string; message: string; refusal?: true } =>
  error instanceof FactsRefusedError
    ? { name: error.name, message: error.message, refusal: true }
    : error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: 'Error', message: String(error) };

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

type JournalThreadData = { readonly databasePath: string; readonly blobsDir: string; readonly port: MessagePort };

const isJournalThreadData = (value: unknown): value is JournalThreadData =>
  typeof value === 'object' && value !== null && typeof (value as { databasePath?: unknown }).databasePath === 'string' &&
  typeof (value as { blobsDir?: unknown }).blobsDir === 'string' &&
  (value as { port?: unknown }).port instanceof MessagePort;

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

const ROOT_RUN_ID = `WITH RECURSIVE up(id, parent) AS (
  SELECT id, parent_run_id FROM runs WHERE id = :runId
  UNION ALL
  SELECT r.id, r.parent_run_id FROM runs r JOIN up ON r.id = up.parent
) SELECT id FROM up WHERE parent IS NULL`;

const TREE_TOKENS = `WITH RECURSIVE tree(id) AS (SELECT :runId UNION ALL SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id = t.id)
SELECT COALESCE(SUM(json_extract(r.usage_json, '$.totalTokens')), 0) AS total FROM runs r JOIN tree t ON r.id = t.id`;

const isRecordValue = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const limitOf = (limits: Record<string, unknown>, key: keyof RunFactsLimits, runId: string): number | undefined => {
  const value = limits[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new TypeError(`run ${runId}: limit ${key} must be a number`);
  return value;
};

const startOf = (event: Extract<RunEvent, { type: 'run.started' }>): { modelAlias: string; mode: PermissionMode } => {
  const { modelAlias } = event.pins;
  if (typeof modelAlias !== 'string') throw new TypeError(`run ${event.runId}: run.started pins.modelAlias must be a string`);
  const mode = PERMISSION_MODES.find((known) => known === event.mode);
  if (mode === undefined) throw new TypeError(`run ${event.runId}: run.started carries no permission mode`);
  return { modelAlias, mode };
};

const agentOf = (pins: Record<string, unknown>, runId: string): string => {
  const { agent } = pins;
  if (agent === undefined) return MAIN_AGENT;
  if (!isRecordValue(agent) || typeof agent['name'] !== 'string') throw new TypeError(`run ${runId}: the agent pin must carry a name`);
  return agent['name'];
};

const refusingFold = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    throw new FactsRefusedError(error instanceof Error ? error.message : String(error), { cause: error });
  }
};

export const runFactsHandler = (db: DatabaseSync, reader: VisitingReader): JournalHandler => {
  const rootOf = db.prepare(ROOT_RUN_ID);
  const treeTokens = db.prepare(TREE_TOKENS);
  return (request) => {
    const runId = textOf(request, 'runId', 'runFacts');
    const fold = createFactsFold();
    const callsFold = createCallsFold(runId);
    let started: ReturnType<typeof startOf> | undefined;
    const run = reader.visitRun(runId, FACTS_EVENT_TYPES, (event) => {
      refusingFold(() => {
        if (event.type === 'run.started') started ??= startOf(event);
        fold.add(event);
        callsFold.add(event);
      });
    });
    if (started === undefined) throw new FactsRefusedError(`run ${runId}: facts need the run.started event and the journal has none`);
    const begun = started;
    const rootRow = rootOf.get({ runId });
    const tokensRow = treeTokens.get({ runId });
    if (rootRow === undefined || tokensRow === undefined) throw new Error(`run ${runId}: its tree could not be read`);
    const facts = refusingFold(() => {
      const maxSteps = limitOf(run.limits, 'maxSteps', runId);
      const maxTotalTokens = limitOf(run.limits, 'maxTotalTokens', runId);
      return fold.finish({
        runId,
        rootRunId: String(rootRow['id']),
        sessionId: run.sessionId,
        status: run.status,
        ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
        createdAt: run.createdAt,
        limits: { ...(maxSteps === undefined ? {} : { maxSteps }), ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }) },
        deadlineAt: run.deadlineAt,
        step: run.step,
        tokensTotal: Number(tokensRow['total']),
        modelAlias: begun.modelAlias,
        mode: begun.mode,
        agent: agentOf(run.pins, runId),
        origin: run.origin,
      });
    });
    return { lastSeq: run.lastSeq, facts, calls: callsFold.finish() };
  };
};

const claimedTokensOf = (request: JournalRequest): ClaimedToken[] => {
  const { tokens } = request;
  if (!Array.isArray(tokens)) throw new TypeError('a fidelity request must carry tokens as a list');
  return tokens.map((entry: unknown): ClaimedToken => {
    const { token, claim } = (entry ?? {}) as { token?: unknown; claim?: unknown };
    if (typeof token !== 'string' || !FIDELITY_CLAIMS.some((known) => known === claim)) {
      throw new TypeError('a fidelity request must carry each token as a string with the claim executed or any');
    }
    return { token, claim: claim as ClaimedToken['claim'] };
  });
};

const throughOf = (request: JournalRequest): number => {
  const { throughEventSeq } = request;
  if (typeof throughEventSeq !== 'number' || !Number.isInteger(throughEventSeq) || throughEventSeq < 0) {
    throw new TypeError('a fidelity request must carry throughEventSeq as a non-negative integer');
  }
  return throughEventSeq;
};

type BlobPages = Pick<BlobStore, 'read'>;

type FidelityPorts = {
  reader: VisitingReader;
  blobs: BlobPages;
  current: { progress: (() => void) | undefined };
  gateFor(post: () => void): { unit(): void };
};

const scanBlob = async (blobs: BlobPages, handle: string, fold: FidelityFold, unit: () => void): Promise<void> => {
  let offset = 0;
  let carry = '';
  for (let totalBytes = Number.POSITIVE_INFINITY; offset < totalBytes && fold.unresolved > 0; ) {
    const page = await blobs.read(handle, { offset, length: FIDELITY_SCAN_PAGE_BYTES });
    totalBytes = page.totalBytes;
    if (page.length === 0) throw new Error(`blob ${handle} returned no bytes at offset ${offset} of ${totalBytes}`);
    offset = page.offset + page.length;
    const text = `${carry}${page.text}`;
    fold.scan(text, offset >= totalBytes);
    carry = text.slice(Math.max(0, text.length - fold.span));
    unit();
  }
};

export const fidelityHandler = ({ reader, blobs, current, gateFor }: FidelityPorts): JournalHandler => async (request, progress) => {
  const runId = textOf(request, 'runId', 'fidelity');
  const fold = createFidelityFold(claimedTokensOf(request), textOf(request, 'cwd', 'fidelity'));
  current.progress = progress;
  let run: ReturnType<VisitingReader['visitRun']>;
  try {
    run = reader.visitRun(runId, FIDELITY_EVENT_TYPES, fold.add, throughOf(request));
  } finally {
    current.progress = undefined;
  }
  fold.finish();
  const gate = gateFor(progress);
  const unreadable: { handle: string; reason: string }[] = [];
  for (const handle of fold.handles) {
    if (fold.unresolved === 0) break;
    try {
      await scanBlob(blobs, handle, fold, gate.unit);
    } catch (error) {
      unreadable.push({ handle, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { lastSeq: run.lastSeq, attested: fold.attested(), unreadable };
};

const withProgress = (current: { progress: (() => void) | undefined }, handler: JournalHandler): JournalHandler => (request, progress) => {
  current.progress = progress;
  try {
    return handler(request, progress);
  } finally {
    current.progress = undefined;
  }
};

const UNUSED_CLOCK = {
  now: (): number => {
    throw new Error('the journal thread reads and has no clock');
  },
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
  const blobs = createBlobStore(db, UNUSED_CLOCK, data.blobsDir);
  serveJournalReader(
    {
      ping: () => ({ threadId }),
      contribution: contributionHandler(reader, current),
      verdict: withProgress(current, verdictHandler(reader)),
      evidence: withProgress(current, evidenceHandler(reader)),
      reflection_input: withProgress(current, reflectionInputHandler(reader)),
      runFacts: withProgress(current, runFactsHandler(db, reader)),
      fidelity: fidelityHandler({ reader, blobs, current, gateFor: (post) => createProgressGate({ now: () => performance.now(), intervalMs: JOURNAL_PROGRESS_INTERVAL_MS, post }) }),
    },
    { incoming: parentPort, outgoing: data.port },
  );
  parentPort.on('close', () => db.close());
  data.port.postMessage({ ready: true, dev: after.dev, ino: after.ino });
};

if (!isMainThread && isJournalThreadData(workerData)) serve(workerData);
