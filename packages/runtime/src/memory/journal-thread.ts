import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { MessagePort, isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import { openDatabase } from '@momonga/foundation/sqlite';
import { REPOSITORY_FACTS_EVENT_TYPES, createRepositoryFactsFold } from '@momonga/memory';
import { RUN_REPORT_EVENT_TYPES, createRunReportFold } from '@momonga/observability/run-report';
import { FactsRefusedError, createBlobStore, createJournalReader, knownValue } from '@momonga/store';
import { FIDELITY_CLAIMS, MAIN_AGENT, PERMISSION_MODES, STORED_MODEL_KEYS, TERMINAL_STATUSES, decodeStoredModel, nanoOfAmount } from '@momonga/protocol';
import { FACTS_EVENT_TYPES, createCallsFold, createFactsFold } from '@momonga/reliability';
import type { Capabilities, ClaimedToken, PermissionMode, RunBudgetReport, RunEvent, RunEventPayload, RunFactsLimits } from '@momonga/protocol';
import type { DatabaseSync } from 'node:sqlite';
import type { BlobStore, JournalReader, UnaskedCommands, WalkUnits } from '@momonga/store';
import { contributionAtTerminal } from './contribution.ts';
import { EVIDENCE_EVENT_TYPES, createEvidenceFold } from './evidence-fold.ts';
import { FIDELITY_EVENT_TYPES, createFidelityFold } from './fidelity-fold.ts';
import type { FidelityFold } from './fidelity-fold.ts';
import { FIDELITY_SCAN_PAGE_BYTES, JOURNAL_PROGRESS_INTERVAL_MS } from './journal-thread-limits.ts';
import { createProgressGate } from './progress-gate.ts';
import { REFLECTION_INPUT_EVENT_TYPES, createReflectionInputFold } from './reflection-input.ts';
import type { KernelLockMechanism } from '@momonga/foundation';
import { kernelLockNamed } from '@momonga/foundation';

export const openJournalConnection = (databasePath: string, busyTimeoutMs: number): ReturnType<typeof openDatabase> => {
  const db = openDatabase(databasePath, { busyTimeoutMs });
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

const errorOf = (error: unknown): { name: string; message: string; code?: string; refusal?: true } => {
  if (error instanceof FactsRefusedError) return { name: error.name, message: error.message, refusal: true };
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

type JournalThreadData = { readonly databasePath: string; readonly blobsDir: string; readonly lockName: KernelLockMechanism['name']; readonly busyTimeoutMs: number; readonly port: MessagePort };

const LOCK_NAMES: readonly KernelLockMechanism['name'][] = ['file-lock', 'sqlite-lock'];

const isJournalThreadData = (value: unknown): value is JournalThreadData =>
  typeof value === 'object' && value !== null && typeof (value as { databasePath?: unknown }).databasePath === 'string' &&
  typeof (value as { blobsDir?: unknown }).blobsDir === 'string' &&
  LOCK_NAMES.includes((value as { lockName?: unknown }).lockName as KernelLockMechanism['name']) &&
  typeof (value as { busyTimeoutMs?: unknown }).busyTimeoutMs === 'number' &&
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

type WalkingReader = Pick<JournalReader, 'walkRun' | 'visitRecord' | 'verdictRows' | 'boundOf'>;

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
  const fold = createEvidenceFold({ paths: textsOf(request, 'paths', 'evidence'), onlyCommand });
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

const FIRST_EVENT_AT = 'SELECT created_at FROM events WHERE run_id = :runId ORDER BY seq LIMIT 1';

const LAST_EVENT_AT = 'SELECT created_at FROM events WHERE run_id = :runId AND seq <= :lastSeq ORDER BY seq DESC LIMIT 1';

const createdAtOf = (row: Record<string, unknown> | undefined, runId: string): number => {
  const createdAt = row?.['created_at'];
  if (typeof createdAt !== 'number') throw new Error(`a run report needs at least one event of the run, and run ${runId} has none`);
  return createdAt;
};

const ROOT_RUN_ID = `WITH RECURSIVE up(id, parent) AS (
  SELECT id, parent_run_id FROM runs WHERE id = :runId
  UNION ALL
  SELECT r.id, r.parent_run_id FROM runs r JOIN up ON r.id = up.parent
) SELECT id FROM up WHERE parent IS NULL`;

const TERMINAL_STATUS_LIST = TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ');

const TREE_SPEND = `WITH RECURSIVE tree(id) AS (SELECT :rootId UNION ALL SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id = t.id)
SELECT COALESCE(SUM(json_extract(r.usage_json, '$.totalTokens')), 0) AS total_tokens,
       COALESCE(SUM(json_extract(r.usage_json, '$.costNano')), 0) AS cost_nano,
       COALESCE(SUM(json_extract(r.usage_json, '$.unpricedCalls')), 0) AS unpriced_calls,
       COALESCE(SUM(CASE WHEN r.status IN (${TERMINAL_STATUS_LIST}) THEN 0 ELSE r.reserved_tokens END), 0) AS reserved_tokens,
       COALESCE(SUM(CASE WHEN r.status IN (${TERMINAL_STATUS_LIST}) THEN 0 ELSE r.reserved_nano END), 0) AS reserved_nano
FROM runs r JOIN tree t ON r.id = t.id`;

const declaredLimit = (limits: Record<string, unknown>, key: string, runId: string): number | undefined => {
  const value = limits[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new TypeError(`run ${runId}: limit ${key} must be a number`);
  return value;
};

const countOf = (row: Record<string, unknown>, column: string, runId: string): number => {
  const value = row[column];
  if (typeof value !== 'number') throw new TypeError(`run ${runId}: the spend of its tree has no numeric ${column}`);
  return value;
};

export const reportHandler = (db: DatabaseSync, reader: VisitingReader): JournalHandler => {
  const firstEventAt = db.prepare(FIRST_EVENT_AT);
  const lastEventAt = db.prepare(LAST_EVENT_AT);
  const rootOf = db.prepare(ROOT_RUN_ID);
  const treeSpend = db.prepare(TREE_SPEND);
  const budgetOf = (run: { id: string; limits: Record<string, unknown>; deadlineAt: number; step: number }): RunBudgetReport => {
    const rootRow = rootOf.get({ runId: run.id });
    if (rootRow === undefined) throw new Error(`run ${run.id}: its tree could not be read`);
    const spend = treeSpend.get({ rootId: String(rootRow['id']) });
    if (spend === undefined) throw new Error(`run ${run.id}: the spend of its tree could not be read`);
    const maxSteps = declaredLimit(run.limits, 'maxSteps', run.id);
    const maxTotalTokens = declaredLimit(run.limits, 'maxTotalTokens', run.id);
    const maxCostUsd = declaredLimit(run.limits, 'maxCostUsd', run.id);
    return {
      limits: {
        ...(maxSteps === undefined ? {} : { maxSteps }),
        ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }),
        ...(maxCostUsd === undefined ? {} : { maxCostNano: nanoOfAmount(maxCostUsd) }),
        deadlineAt: run.deadlineAt,
      },
      spent: { steps: run.step, totalTokens: countOf(spend, 'total_tokens', run.id), costNano: countOf(spend, 'cost_nano', run.id), unpricedCalls: countOf(spend, 'unpriced_calls', run.id) },
      reserved: { tokens: countOf(spend, 'reserved_tokens', run.id), costNano: countOf(spend, 'reserved_nano', run.id) },
    };
  };
  return (request) => {
    const runId = textOf(request, 'runId', 'report');
    const fold = createRunReportFold();
    const run = reader.visitRun(runId, RUN_REPORT_EVENT_TYPES, fold.add);
    const report = fold.finish({
      runId,
      budget: budgetOf(run),
      firstCreatedAt: createdAtOf(firstEventAt.get({ runId }), runId),
      lastCreatedAt: createdAtOf(lastEventAt.get({ runId, lastSeq: run.lastSeq }), runId),
    });
    return { lastSeq: run.lastSeq, report };
  };
};

const TREE_TOKENS = `WITH RECURSIVE tree(id) AS (SELECT :runId UNION ALL SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id = t.id)
SELECT COALESCE(SUM(json_extract(r.usage_json, '$.totalTokens')), 0) AS total, COALESCE(SUM(json_extract(r.usage_json, '$.costNano')), 0) AS cost_nano FROM runs r JOIN tree t ON r.id = t.id`;

const isRecordValue = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const limitOf = (limits: Record<string, unknown>, key: 'maxSteps' | 'maxTotalTokens' | 'maxCostUsd', runId: string): number | undefined => {
  const value = limits[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new TypeError(`run ${runId}: limit ${key} must be a number`);
  return value;
};

const startOf = (event: Extract<RunEvent, { type: 'run.started' }>): { model: string; mode: PermissionMode } => {
  const model = decodeStoredModel(event.pins, STORED_MODEL_KEYS.pin);
  if (model === undefined) throw new TypeError(`run ${event.runId}: run.started pins.model must be a string`);
  const mode = PERMISSION_MODES.find((known) => known === event.mode);
  if (mode === undefined) throw new TypeError(`run ${event.runId}: run.started carries no permission mode`);
  return { model, mode };
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
      const maxCostUsd = limitOf(run.limits, 'maxCostUsd', runId);
      return fold.finish({
        runId,
        rootRunId: String(rootRow['id']),
        sessionId: run.sessionId,
        status: knownValue(run.status, `the status of run ${runId}`),
        ...(run.stopReason === undefined ? {} : { stopReason: knownValue(run.stopReason, `the stop reason of run ${runId}`) }),
        createdAt: run.createdAt,
        limits: {
          ...(maxSteps === undefined ? {} : { maxSteps }),
          ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }),
          ...(maxCostUsd === undefined ? {} : { maxCostNano: nanoOfAmount(maxCostUsd) }),
        },
        deadlineAt: run.deadlineAt,
        step: run.step,
        tokensTotal: Number(tokensRow['total']),
        costNano: Number(tokensRow['cost_nano']),
        model: begun.model,
        mode: begun.mode,
        agent: agentOf(run.pins, runId),
        origin: run.origin,
      });
    });
    return { lastSeq: run.lastSeq, facts, calls: callsFold.finish() };
  };
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

const isRequestFields = (value: unknown): value is JournalRequest => typeof value === 'object' && value !== null && !Array.isArray(value);

const unaskedOf = (value: unknown, kind: string): UnaskedCommands => {
  if (!isRequestFields(value)) throw new TypeError(`a ${kind} request must carry unasked as the commands that run without asking`);
  return { readOnly: textsOf(value, 'readOnly', kind), edit: textsOf(value, 'edit', kind) };
};

type PlanningReader = Pick<JournalReader, 'planInheritance'>;

type WindowReader = Pick<JournalReader, 'readInheritedWindow'>;

export const inheritPlanHandler = (reader: PlanningReader): JournalHandler => (request) =>
  reader.planInheritance({
    runId: textOf(request, 'runId', 'inherit_plan'),
    mode: modeOf(request['mode'], 'inherit_plan'),
    unasked: unaskedOf(request['unasked'], 'inherit_plan'),
  });

export const inheritedWindowHandler = (reader: WindowReader): JournalHandler => (request) =>
  reader.readInheritedWindow({
    runId: textOf(request, 'runId', 'inherited_window'),
    windowTokens: numberOf(request, 'windowTokens', 'inherited_window'),
    floorTokens: numberOf(request, 'floorTokens', 'inherited_window'),
  });

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
  reader: WalkingReader;
  blobs: BlobPages;
  current: { progress: (() => void) | undefined };
  gateFor(post: () => void): { unit(): void };
};

const scanBlob = async (blobs: BlobPages, handle: string, fold: FidelityFold, unit: () => void): Promise<boolean> => {
  let offset = 0;
  let totalBytes = Number.POSITIVE_INFINITY;
  let carry = '';
  while (offset < totalBytes && fold.unresolved > 0) {
    const page = await blobs.read(handle, { offset, length: FIDELITY_SCAN_PAGE_BYTES });
    totalBytes = page.totalBytes;
    if (page.length === 0) throw new Error(`blob ${handle} returned no bytes at offset ${offset} of ${totalBytes}`);
    offset = page.offset + page.length;
    const text = `${carry}${page.text}`;
    fold.scan(text, offset >= totalBytes, handle);
    carry = text.slice(Math.max(0, text.length - fold.span));
    unit();
  }
  return offset >= totalBytes;
};

const yieldToThread = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const fidelityHandler = ({ reader, blobs, current, gateFor }: FidelityPorts): JournalHandler => async (request, progress) => {
  const runId = textOf(request, 'runId', 'fidelity');
  const cwd = textOf(request, 'cwd', 'fidelity');
  const claimed = claimedTokensOf(request);
  const names = claimed.map((entry) => entry.token);
  const through = throughOf(request);
  const unreadable: { handle: string; reason: string }[] = [];
  const pause = async (): Promise<void> => {
    await yieldToThread();
    current.progress = progress;
  };
  let chainStopped = false;
  const ownUnits: WalkUnits = { pause, stop: () => false };
  const chainUnits: WalkUnits = {
    pause,
    stop: () => {
      if (fold.unresolved > 0) return false;
      chainStopped = true;
      return true;
    },
  };
  const fold: FidelityFold = createFidelityFold(claimed, cwd, (event, add) =>
    reader.visitRecord({
      reference: event,
      types: FIDELITY_EVENT_TYPES,
      visit: add,
      units: chainUnits,
      onFault: (fault) => unreadable.push({ handle: `chain:${fault.runId}`, reason: fault.reason }),
      cover: (hop) => {
        const rows = reader.verdictRows(hop.runId, cwd, names);
        const held = names.map((name) => rows.get(name));
        if (names.length === 0 || held.some((row) => row === undefined || row.checkedThrough > hop.bound)) return undefined;
        for (const row of held) if (row !== undefined) fold.applyHop(row.token, row, hop.omitsTask);
        return Math.min(...held.map((row) => (row === undefined ? hop.bound : row.checkedThrough))) + 1;
      },
    }),
  );
  const own = reader.verdictRows(runId, cwd, names);
  const bound = reader.boundOf(runId, through);
  const heldOwn = names.map((name) => own.get(name));
  const resumeFrom =
    names.length === 0 || heldOwn.some((row) => row === undefined || row.checkedThrough > bound)
      ? undefined
      : Math.min(...heldOwn.map((row) => (row === undefined ? bound : row.checkedThrough))) + 1;
  if (resumeFrom !== undefined) {
    for (const row of heldOwn) if (row !== undefined) fold.seedOwn(row);
    fold.resumeAfterTask();
  }
  current.progress = progress;
  let run: Awaited<ReturnType<WalkingReader['walkRun']>>;
  try {
    run = await reader.walkRun(runId, FIDELITY_EVENT_TYPES, fold.add, ownUnits, { throughSeq: through, ...(resumeFrom === undefined ? {} : { from: resumeFrom }) });
  } finally {
    current.progress = undefined;
  }
  const gate = gateFor(progress);
  let blobsStopped = false;
  for (const handle of fold.handles.keys()) {
    if (fold.unresolved === 0) {
      blobsStopped = true;
      break;
    }
    try {
      if (!(await scanBlob(blobs, handle, fold, gate.unit))) blobsStopped = true;
    } catch (error) {
      unreadable.push({ handle, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const floor = fold.pendingFloor();
  fold.finish();
  const exact = !chainStopped && !fold.chainSkipped && !blobsStopped;
  const verdicts = unreadable.length > 0 ? [] : fold.verdicts().filter((verdict) => exact || verdict.inh === 'executed' || verdict.executedAt !== null);
  return { lastSeq: run.lastSeq, attested: fold.attested(), unreadable, checkedThrough: floor === undefined ? bound : floor - 1, verdicts };
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
  const db = openJournalConnection(data.databasePath, data.busyTimeoutMs);
  const after = identityOf(data.databasePath);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    db.close();
    throw new Error(`database file ${data.databasePath} was replaced while the journal thread opened it`);
  }
  const current: { progress: (() => void) | undefined } = { progress: undefined };
  const gate = createProgressGate({ now: () => performance.now(), intervalMs: JOURNAL_PROGRESS_INTERVAL_MS, post: () => current.progress?.() });
  const reader = createJournalReader(db, { unit: gate.unit });
  const blobs = createBlobStore(db, UNUSED_CLOCK, data.blobsDir, { fileSystem: nodeFileSystem, random: systemRandom, lock: kernelLockNamed(data.lockName) });
  serveJournalReader(
    {
      ping: () => ({ threadId }),
      contribution: contributionHandler(reader, current),
      verdict: withProgress(current, verdictHandler(reader)),
      evidence: withProgress(current, evidenceHandler(reader)),
      reflection_input: withProgress(current, reflectionInputHandler(reader)),
      runFacts: withProgress(current, runFactsHandler(db, reader)),
      report: withProgress(current, reportHandler(db, reader)),
      fidelity: fidelityHandler({ reader, blobs, current, gateFor: (post) => createProgressGate({ now: () => performance.now(), intervalMs: JOURNAL_PROGRESS_INTERVAL_MS, post }) }),
      inherit_plan: withProgress(current, inheritPlanHandler(reader)),
      inherited_window: withProgress(current, inheritedWindowHandler(reader)),
    },
    { incoming: parentPort, outgoing: data.port },
  );
  parentPort.on('close', () => db.close());
  data.port.postMessage({ ready: true, dev: after.dev, ino: after.ino });
};

if (!isMainThread && isJournalThreadData(workerData)) serve(workerData);
