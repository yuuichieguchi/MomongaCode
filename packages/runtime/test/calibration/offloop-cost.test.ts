import fs from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createRedactor } from '@momonga/foundation';
import { buildRunReport } from '@momonga/observability';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { HISTORY_INDEX_BATCH_CHARS } from '@momonga/store';
import type { ContributionPreparer } from '@momonga/store';
import { startJournalThread } from '../../src/memory/journal-thread-client.ts';
import type { JournalThreadClient } from '../../src/memory/journal-thread-client.ts';
import { JOURNAL_THREAD_SILENCE_LIMIT_MS } from '../../src/memory/journal-thread-limits.ts';
import { journalReaderPreparer, makeEnv } from '../worker/harness.ts';
import type { Env } from '../worker/harness.ts';
import { foldedThrough, seedLargeRun } from '../worker/large-run.ts';

const SIZES = [15, 50, 150, 1000] as const;
const BODY_TOKENS = [100_000, 400_000, 1_000_000] as const;
const CHARS_PER_TOKEN = 4;
const TICK_MS = 5;
const SNAPSHOT_INTERVAL_EVENTS = 200;
const MB = 1024 * 1024;
const READ_CHUNK = 1000;
const CALIBRATION_TIMEOUT_MS = 30 * 60 * 1000;

type Timed<T> = { value: T; wallMs: number; loopCpuMs: number; loopGapMs: number };

const timed = async <T>(work: () => T | Promise<T>): Promise<Timed<T>> => {
  let last = performance.now();
  let loopGapMs = 0;
  const observe = (): void => {
    const now = performance.now();
    loopGapMs = Math.max(loopGapMs, now - last);
    last = now;
  };
  const ticker = setInterval(observe, TICK_MS);
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  try {
    const value = await work();
    const wallMs = performance.now() - started;
    const used = process.threadCpuUsage(cpuBefore);
    observe();
    return { value, wallMs, loopCpuMs: (used.user + used.system) / 1000, loopGapMs };
  } finally {
    clearInterval(ticker);
  }
};

type Counter = { rows: number; bytes: number; encoded: Map<string, number> };

const newCounter = (): Counter => ({ rows: 0, bytes: 0, encoded: new Map() });

const reset = (counter: Counter): void => {
  counter.rows = 0;
  counter.bytes = 0;
  counter.encoded.clear();
};

const round = (value: number): number => Math.round(value * 10) / 10;

const perMb = (ms: number, bytes: number): number => (bytes === 0 ? 0 : round(ms / (bytes / MB)));

const INDEXED_PROBE = `SELECT COALESCE(SUM(length(payload_json)), 0) AS chars FROM events WHERE run_id = :runId AND type IN ('user.message', 'model.responded', 'tool.call', 'tool.completed')`;

const threadOf = (dbPath: () => string): { preparer: ContributionPreparer; client(): Promise<JournalThreadClient>; close(): Promise<void> } => {
  let started: Promise<JournalThreadClient> | undefined;
  const client = (): Promise<JournalThreadClient> => {
    started ??= (() => {
      const databasePath = dbPath();
      const { dev, ino } = fs.statSync(databasePath);
      return startJournalThread({ databasePath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });
    })();
    return started;
  };
  return {
    client,
    preparer: {
      measure: async (request) => (await client()).measure(request),
      inheritPlan: async (request) => (await client()).inheritPlan(request),
      inheritedWindow: async (request) => (await client()).inheritedWindow(request),
      verdict: async (request) => (await client()).verdict(request),
      evidence: async (request) => (await client()).evidence(request),
      reflectionInput: async (request) => (await client()).reflectionInput(request),
      fidelity: async (request) => (await client()).fidelity(request),
      report: async (request) => (await client()).report(request),
    },
    close: async () => {
      if (started !== undefined) await (await started).close();
    },
  };
};

type Measured = Record<string, number>;

const eventsOf = (env: Env, runId: string): RunEvent[] => {
  const events: RunEvent[] = [];
  for (let after = 0; ; ) {
    const chunk = env.store.readRunEvents(runId, after, READ_CHUNK);
    events.push(...chunk);
    const last = chunk.at(-1);
    if (last === undefined || chunk.length < READ_CHUNK) return events;
    after = last.seq;
  }
};

const measureSize = async (steps: number): Promise<Measured> => {
  const counter = newCounter();
  let dbPath = '';
  const thread = threadOf(() => dbPath);
  const env: Env = await makeEnv({
    mode: 'bypassPermissions',
    preparer: thread.preparer,
    onDecode: (rows, bytes) => {
      counter.rows += rows;
      counter.bytes += bytes;
    },
    onEncode: (kind, bytes) => {
      counter.encoded.set(kind, (counter.encoded.get(kind) ?? 0) + bytes);
    },
  });
  dbPath = env.dbPath;
  try {
    const { run, claim } = await seedLargeRun(env, steps);
    const journalBytes = counter.encoded.get('event') ?? 0;
    const lastSeq = env.run(run.id).lastSeq;
    const spawn = await timed(async () => {
      const { dev, ino } = fs.statSync(env.dbPath);
      return startJournalThread({ databasePath: env.dbPath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });
    });
    await spawn.value.close();

    reset(counter);
    const loadWhole = await timed(() => env.store.load(run.id));
    const wholeTail = { rows: counter.rows, bytes: counter.bytes };

    const behindSeq = Math.max(0, lastSeq - (SNAPSHOT_INTERVAL_EVENTS - 1));
    let behindTail = wholeTail;
    let loadBehind = loadWhole;
    if (behindSeq > 0) {
      const behind = foldedThrough(env, run, behindSeq);
      expect(env.store.writeSnapshot(claim, behindSeq, behind).kind).toBe('ok');
      reset(counter);
      loadBehind = await timed(() => env.store.load(run.id));
      behindTail = { rows: counter.rows, bytes: counter.bytes };
    }

    const state = foldedThrough(env, run, lastSeq);
    reset(counter);
    const write = await timed(() => env.store.writeSnapshot(claim, state.lastSeq, state));
    expect(write.value.kind).toBe('ok');
    const snapshotBytes = counter.encoded.get('snapshot') ?? 0;
    reset(counter);
    const loadCurrent = await timed(() => env.store.load(run.id));
    const currentTail = { rows: counter.rows, bytes: counter.bytes };

    const viaThread = await timed(async () => (await thread.client()).measure({ runId: run.id, leading: [] }));
    const inline = await timed(() => journalReaderPreparer(env.dbPath).measure({ runId: run.id, leading: [] }));

    reset(counter);
    const reportThread = await timed(() => thread.preparer.report({ runId: run.id }));
    const reportLoop = { rows: counter.rows, bytes: counter.bytes };
    reset(counter);
    const reportInline = await timed(() => buildRunReport(eventsOf(env, run.id)));
    const reportInlineLoop = { rows: counter.rows, bytes: counter.bytes };
    expect(reportThread.value.report).toMatchObject(reportInline.value);

    const probe = await timed(() => env.raw().prepare(INDEXED_PROBE).get({ runId: run.id }));
    const indexedChars = Number(probe.value?.['chars']);

    reset(counter);
    const terminal = await timed(() => env.store.transition(claim, ['RUNNING'], 'COMPLETED'));
    expect(terminal.value.kind).toBe('ok');
    const terminalCounts = { rows: counter.rows, bytes: counter.bytes };

    const redactor = createRedactor({ credentials: [] });
    await env.store.search.indexBatch({ limit: 1, redactor, maxChars: HISTORY_INDEX_BATCH_CHARS });
    const index = await timed(() => env.store.search.indexBatch({ limit: 1, redactor, maxChars: HISTORY_INDEX_BATCH_CHARS }));
    expect(index.value.runs).toBe(1);

    return {
      steps,
      events: lastSeq,
      journalMb: round(journalBytes / MB),
      threadSpawnMs: round(spawn.wallMs),
      snapshotMb: round(snapshotBytes / MB),
      snapshotWriteMs: round(write.loopCpuMs),
      snapshotWriteMsPerMb: perMb(write.loopCpuMs, snapshotBytes),
      claimStartSnapshotAtLastSeqMs: round(loadCurrent.loopCpuMs),
      claimStartSnapshotAtLastSeqMsPerMb: perMb(loadCurrent.loopCpuMs, snapshotBytes),
      claimStartSnapshotAtLastSeqTailRows: currentTail.rows,
      claimStartSnapshotAtLastSeqTailMb: round(currentTail.bytes / MB),
      claimStartSnapshotBehindMs: round(loadBehind.loopCpuMs),
      claimStartSnapshotBehindTailRows: behindTail.rows,
      claimStartSnapshotBehindTailMb: round(behindTail.bytes / MB),
      claimStartNoSnapshotMs: round(loadWhole.loopCpuMs),
      claimStartNoSnapshotTailRows: wholeTail.rows,
      claimStartNoSnapshotTailMb: round(wholeTail.bytes / MB),
      contributionThreadWallMs: round(viaThread.wallMs),
      contributionThreadMsPerMb: perMb(viaThread.wallMs, journalBytes),
      contributionThreadMsPerEvent: round(viaThread.wallMs / lastSeq),
      contributionThreadLoopCpuMs: round(viaThread.loopCpuMs),
      contributionThreadLoopGapMs: round(viaThread.loopGapMs),
      contributionInlineMs: round(inline.loopCpuMs),
      contributionInlineMsPerMb: perMb(inline.loopCpuMs, journalBytes),
      contributionInlineLoopGapMs: round(inline.loopGapMs),
      reportThreadWallMs: round(reportThread.wallMs),
      reportThreadLoopCpuMs: round(reportThread.loopCpuMs),
      reportThreadLoopGapMs: round(reportThread.loopGapMs),
      reportLoopDecodedRows: reportLoop.rows,
      reportLoopDecodedMb: round(reportLoop.bytes / MB),
      reportInlineMs: round(reportInline.loopCpuMs),
      reportInlineMsPerMb: perMb(reportInline.loopCpuMs, journalBytes),
      reportInlineDecodedRows: reportInlineLoop.rows,
      reportInlineDecodedMb: round(reportInlineLoop.bytes / MB),
      terminalWallMs: round(terminal.wallMs),
      terminalLoopCpuMs: round(terminal.loopCpuMs),
      terminalLoopGapMs: round(terminal.loopGapMs),
      terminalLoopDecodedRows: terminalCounts.rows,
      terminalLoopDecodedMb: round(terminalCounts.bytes / MB),
      indexedChars,
      indexedProbeMs: round(probe.loopCpuMs),
      indexedProbeMsPerMillionChars: indexedChars === 0 ? 0 : round(probe.loopCpuMs / (indexedChars / 1_000_000)),
      indexRunAloneMs: round(index.loopCpuMs),
      indexRunAloneLoopGapMs: round(index.loopGapMs),
    };
  } finally {
    await thread.close();
  }
};

const bodyDecode = async (tokens: number): Promise<Measured> => {
  const env = await makeEnv({ mode: 'bypassPermissions' });
  const run = await env.enqueue('Read one body', { history: 'fresh' });
  const half = (tokens * CHARS_PER_TOKEN) / 2;
  const content = `${'src/module/file.ts handler '.repeat(Math.ceil(half / 27)).slice(0, half)}${'設定ファイルの読み込みに失敗しました。'.repeat(Math.ceil(half / 19)).slice(0, half)}`;
  const request: RunEventPayload = { type: 'model.requested', step: 1, attempt: 1, digest: 'digest-1', body: { model: 'fm', input: [{ type: 'message', role: 'user', content }] } };
  await env.seed(run.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'manual' }, request], 'hold');
  const row = env.raw().prepare("SELECT length(CAST(payload_json AS BLOB)) AS bytes FROM events WHERE run_id = ? AND type = 'model.requested'").get(run.id);
  const bytes = Number(row?.['bytes']);
  const lastSeq = env.run(run.id).lastSeq;
  const decode = await timed(() => env.store.readLatestRunEventBefore(run.id, 'model.requested', lastSeq + 1));
  expect(decode.value?.type).toBe('model.requested');
  return { tokens, bodyMb: round(bytes / MB), decodeMs: round(decode.loopCpuMs), decodeMsPerMb: perMb(decode.loopCpuMs, bytes) };
};

describe('what a unit of journal work costs on this host (design section 7, calibration check)', () => {
  it('records the costs of the journal thread, the inline control, the run state snapshot, the claim start, the run report, the search indexing probe and a recorded request body', async () => {
    const [cpu] = os.cpus();
    const host = { cpu: cpu?.model, cores: os.availableParallelism(), platform: `${os.platform()}-${os.arch()}`, node: process.version, loadAverage1m: round(os.loadavg()[0] ?? 0), coreClass: 'not pinned: the scheduler of the host chooses' };
    console.info(`offloop calibration host ${JSON.stringify(host)}`);
    const sizes: Measured[] = [];
    for (const steps of SIZES) {
      const measured = await measureSize(steps);
      console.info(`offloop calibration size ${JSON.stringify(measured)}`);
      sizes.push(measured);
    }
    const bodies: Measured[] = [];
    for (const tokens of BODY_TOKENS) {
      const measured = await bodyDecode(tokens);
      console.info(`offloop calibration body ${JSON.stringify(measured)}`);
      bodies.push(measured);
    }
    expect(sizes.map((size) => size['steps'])).toEqual([...SIZES]);
    expect(bodies).toHaveLength(BODY_TOKENS.length);
  }, CALIBRATION_TIMEOUT_MS);
});
