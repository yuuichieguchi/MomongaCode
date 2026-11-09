import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { canonicalJson, migrate } from '@momonga/foundation';
import { assistantTextOf } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import { foldRunState, initialRunState, openRuntimeStore } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { fixtureCompactionItem, materializeEvents, createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { LEASE_MS, START_MS, enqueue, harness, makeStoreDir, mustClaim, newSession, openStoreAt, registerCleanup } from './helpers.ts';

const USAGE = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };

const requested = (step: number, attempt = 1): RunEventPayload => ({ type: 'model.requested', step, attempt, digest: `d${step}-${attempt}`, body: { tool_choice: 'auto' } });

const rejected = (step: number, attempt: number): RunEventPayload => ({ type: 'model.rejected', step, attempt, reason: 'overloaded' } as unknown as RunEventPayload);

const respondedWith = (step: number, attempt: number, output: unknown[]): RunEventPayload =>
  ({ type: 'model.responded', step, attempt, response: { status: 'completed', output, usage: USAGE } }) as RunEventPayload;

const message = (id: string, ...texts: string[]) => ({ type: 'message', id, role: 'assistant', content: texts.map((text) => ({ type: 'output_text', text })) });

const functionCall = (callId: string) => ({ type: 'function_call', id: `fc-${callId}`, call_id: callId, name: 'Write', arguments: '{}' });

const call = (callId: string): RunEventPayload => ({ type: 'tool.call', callId, providerCallId: callId, name: 'Write', kind: 'edit', title: callId, rawInput: { id: callId } });

const started = (callId: string, idemKey: string): RunEventPayload => ({ type: 'tool.started', callId, idemKey });

const completed = (callId: string): RunEventPayload => ({ type: 'tool.completed', callId, status: 'completed', output: `output of ${callId}` });

const reconciled = (callId: string): RunEventPayload => ({ type: 'tool.reconciled', callId, outcome: 'already_applied', output: `reconciled ${callId}` });

const COMPACTED: RunEventPayload = { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'summary'), summary: 'summary', replacedThroughSeq: 1 };

const rejectedCompaction = (attempt: { step: number; attempt: number } | undefined): RunEventPayload => ({
  type: 'context.compaction_rejected',
  ...(attempt ?? {}),
  item: { type: 'message', role: 'user', content: '<conversation_summary>\nsummary\n</conversation_summary>' },
});

const SCENARIOS: Record<string, RunEventPayload[]> = {
  'the text of an earlier response when the latest responses carry only tool calls': [
    requested(1),
    respondedWith(1, 1, [message('m1', 'first answer')]),
    requested(2),
    respondedWith(2, 1, [functionCall('c1')]),
  ],
  'the last message with text of a response of several messages': [requested(1), respondedWith(1, 1, [message('m1', 'one', ' and two'), message('m2'), message('m3', 'three'), message('m4')])],
  'no text at all': [requested(1), respondedWith(1, 1, [functionCall('c1')])],
  'a request that was rejected twice and is now on its third attempt': [requested(1), rejected(1, 1), rejected(1, 2)],
  'a request answered by the attempt in flight': [requested(1), rejected(1, 1), respondedWith(1, 2, [message('m1', 'answer')])],
  'a request whose answer belongs to an earlier attempt': [requested(1), rejected(1, 1), respondedWith(1, 1, [message('m1', 'stale')])],
  'a request replaced by the request of the next step': [requested(1), requested(2)],
  'a rejection that names another step': [requested(2), rejected(1, 1)],
  'a compaction rejected for the request in flight': [requested(1), respondedWith(1, 1, [message('m1', 'before')]), COMPACTED, requested(2), rejectedCompaction({ step: 2, attempt: 1 })],
  'a compaction rejected without naming a request': [requested(1), respondedWith(1, 1, [message('m1', 'before')]), COMPACTED, requested(2), rejectedCompaction(undefined)],
  'started calls, some finished and some not': [
    call('c1'),
    call('c2'),
    call('c3'),
    call('c4'),
    call('c5'),
    started('c1', 'k1'),
    started('c2', 'k2'),
    started('c4', 'k4'),
    started('c5', 'k5-first'),
    completed('c1'),
    reconciled('c4'),
    started('c5', 'k5-second'),
  ],
};

type Facts = { finalText: string; inFlight: { step: number; attempt: number } | undefined; started: { callId: string; name: string; idemKey: string }[] };

const USER_MESSAGE: RunEventPayload = { type: 'user.message', text: 'do the task' };

const todaysFacts = (payloads: readonly RunEventPayload[]): Facts => {
  const events = materializeEvents([USER_MESSAGE, ...payloads], { runId: 'run-fixture', sessionId: 'session-fixture' });
  const state = events.reduce(foldRunState, initialRunState({ runId: 'run-fixture', sessionId: 'session-fixture' }));
  const finalText = [...state.history].reverse().map((entry) => assistantTextOf([entry.item])).find((text) => text !== '') ?? '';
  return {
    finalText,
    inFlight: state.inFlightModelRequest === undefined ? undefined : { step: state.inFlightModelRequest.step, attempt: state.inFlightModelRequest.attempt },
    started: Object.entries(state.pendingCalls).flatMap(([callId, pending]) =>
      pending.idemKey !== undefined && pending.status !== 'completed' && pending.status !== 'reconciled' ? [{ callId, name: pending.name, idemKey: pending.idemKey }] : [],
    ),
  };
};

const recordedFacts = async (store: RuntimeStore, runId: string): Promise<Facts> => ({
  finalText: await store.finalTextOf(runId),
  inFlight: await store.inFlightModelRequestOf(runId),
  started: await store.startedCallsOf(runId),
});

const countingStore = (dbPath: string, decoded: { rows: number }): RuntimeStore => {
  const store = openRuntimeStore({
    path: dbPath,
    home: path.dirname(dbPath),
    clock: createFakeClock(START_MS),
    leaseMs: LEASE_MS,
    maxAttempts: 5,
    maxTotalAttempts: 1000,
    onDecode: (rows) => {
      decoded.rows += rows;
    },
  });
  registerCleanup(() => store.close());
  return store;
};

describe('the final text, the in-flight request and the started calls of a run are records written at append, and answer as the fold of the journal does (row 3)', () => {
  it.each(Object.entries(SCENARIOS))('%s', async (_name, payloads) => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id, 'do the task');
    const claim = mustClaim(store, 'w1');
    expect(store.append(claim, payloads).kind).toBe('ok');
    expect(await recordedFacts(store, run.id)).toEqual(todaysFacts(payloads));
  });

  it('keeps the text of the latest response that has text after a compaction replaced it, where the fold of the history answers an empty text', async () => {
    const payloads = [
      requested(1),
      respondedWith(1, 1, [message('m1', 'before')]),
      { ...COMPACTED, replacedThroughSeq: 2 } as RunEventPayload,
      requested(2),
      respondedWith(2, 1, [functionCall('c1')]),
    ];
    const { store } = harness();
    const run = enqueue(store, newSession(store).id, 'do the task');
    const claim = mustClaim(store, 'w1');
    expect(store.append(claim, payloads).kind).toBe('ok');
    expect(todaysFacts(payloads).finalText).toBe('');
    expect(await store.finalTextOf(run.id)).toBe('before');
  });

  it('answers an empty text and no request or call for a run that recorded nothing', async () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id, 'do the task');
    expect(await recordedFacts(store, run.id)).toEqual({ finalText: '', inFlight: undefined, started: [] });
  });

  it('reads no journal payload on the main thread', async () => {
    const decoded = { rows: 0 };
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    const store = countingStore(dbPath, decoded);
    const run = enqueue(store, newSession(store).id, 'do the task');
    const claim = mustClaim(store, 'w1');
    const payloads = SCENARIOS['started calls, some finished and some not'];
    if (payloads === undefined) throw new Error('missing scenario');
    expect(store.append(claim, [...payloads, requested(1), respondedWith(1, 1, [message('m1', 'text')]), requested(2)]).kind).toBe('ok');
    decoded.rows = 0;
    await recordedFacts(store, run.id);
    expect(decoded.rows).toBe(0);
  });
});

const versionNineteen = (journals: Record<string, readonly RunEventPayload[]>): { dbPath: string; runIds: Record<string, string> } => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  const runIds: Record<string, string> = {};
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 19));
    db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/work/a', '{}', 'default', 'fm', START_MS);
    const insertRun = db.prepare(
      `INSERT INTO runs (id, session_id, ordinal, status, version, lease_owner, lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at)
       VALUES (?, 's1', ?, 'COMPLETED', 1, NULL, 1, 0, ?, 1, 0, 0, ?, '{}', ?, 1, ?, '{}', 0, ?)`,
    );
    const insertEvent = db.prepare('INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (?, ?, ?, ?, 1, ?, ?, ?)');
    Object.entries(journals).forEach(([name, payloads], index) => {
      const runId = `r${index + 1}`;
      runIds[name] = runId;
      const all = [USER_MESSAGE, ...payloads];
      insertRun.run(runId, index + 1, START_MS, START_MS + 3_600_000, canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), all.length, START_MS);
      let step = 0;
      all.forEach((payload, at) => {
        step = Math.max(step, 'step' in payload ? payload.step : 0);
        insertEvent.run(runId, 's1', at + 1, step, START_MS, payload.type, canonicalJson(payload));
      });
    });
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  return { dbPath, runIds };
};

describe('an upgrade from version 19 derives the same records from the journals written before them', () => {
  it('gives each old run the facts the fold of its journal gives', async () => {
    const { dbPath, runIds } = versionNineteen(SCENARIOS);
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 10));
    for (const [name, payloads] of Object.entries(SCENARIOS)) {
      const runId = runIds[name];
      if (runId === undefined) throw new Error(`no run for ${name}`);
      expect(await recordedFacts(store, runId), name).toEqual(todaysFacts(payloads));
    }
  });
});

type MeterPayload = Extract<RunEventPayload, { type: 'meter.observed' }>;

const meterPayload = (index: number, key: { contextWindow: number; tokenErrorRatio?: number; tokenCounting: MeterPayload['tokenCounting'] }): MeterPayload => ({
  type: 'meter.observed',
  target: 'primary',
  counter: 'counter-a',
  fallback: false,
  inputDigest: `input-${index}`,
  itemCount: index,
  counted: 100 + index,
  reported: 110 + index,
  kept: 100,
  known: 90,
  uncounted: index,
  miss: index % 5,
  ...key,
});

const METER_KEYS = [
  { contextWindow: 1000, tokenCounting: 'exact' as const },
  { contextWindow: 2000, tokenCounting: 'exact' as const },
  { contextWindow: 1000, tokenErrorRatio: 0.25, tokenCounting: 'estimated' as const },
];

const meterJournal = (from: number, count: number): MeterPayload[] =>
  Array.from({ length: count }, (_unused, offset) => meterPayload(from + offset, METER_KEYS[(from + offset) % METER_KEYS.length] as (typeof METER_KEYS)[number]));

const MISS_WINDOW = 20;

const meterOracle = (runs: readonly { runId: string; payloads: readonly MeterPayload[] }[]) => {
  const records = new Map<string, { runId: string; seq: number; event: MeterPayload; misses: { miss: number; uncounted: number }[] }>();
  for (const { runId, payloads } of runs) {
    payloads.forEach((event, at) => {
      const key = canonicalJson([event.contextWindow, event.tokenErrorRatio ?? null, event.tokenCounting]);
      const previous = records.get(key)?.misses ?? [];
      records.set(key, { runId, seq: at + 2, event, misses: [...previous, { miss: event.miss, uncounted: event.uncounted }].slice(-MISS_WINDOW) });
    });
  }
  return records;
};

const meterRecordsOf = async (store: RuntimeStore, sessionId: string) =>
  new Map(
    await Promise.all(
      METER_KEYS.map(async (key) => {
        const record = await store.meterRecordOf(sessionId, { counter: 'counter-a', ...key });
        return [canonicalJson([key.contextWindow, key.tokenErrorRatio ?? null, key.tokenCounting]), record] as const;
      }),
    ),
  );

describe('the meter record of a session keeps the latest observation and the last misses of each key', () => {
  it('is updated at append', async () => {
    const { store } = harness();
    const session = newSession(store);
    const run = enqueue(store, session.id, 'do the task');
    const claim = mustClaim(store, 'w1');
    const payloads = meterJournal(0, 27);
    expect(store.append(claim, payloads.slice(0, 10)).kind).toBe('ok');
    expect(store.append(claim, payloads.slice(10)).kind).toBe('ok');
    expect(await meterRecordsOf(store, session.id)).toEqual(meterOracle([{ runId: run.id, payloads }]));
  });

  it('is derived once, at an upgrade from version 19, from the observations of every run of the session', async () => {
    const first = meterJournal(0, 15);
    const second = meterJournal(15, 12);
    const { dbPath } = versionNineteen({ first, second });
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 10));
    expect(await meterRecordsOf(store, 's1')).toEqual(
      meterOracle([
        { runId: 'r1', payloads: first },
        { runId: 'r2', payloads: second },
      ]),
    );
  });

  it('has no record for a key that was never observed', async () => {
    const { store } = harness();
    const session = newSession(store);
    enqueue(store, session.id, 'do the task');
    expect(await store.meterRecordOf(session.id, { counter: 'counter-a', contextWindow: 1000, tokenCounting: 'exact' })).toBeUndefined();
  });
});

const notice = (code: string | undefined): RunEventPayload => ({ type: 'notice', level: 'warning', message: `notice ${code ?? 'without a code'}`, ...(code === undefined ? {} : { code }) });

describe('the codes of the notices of a run are a column, so asking for one reads no payload', () => {
  const journals = { dropped: [notice(undefined), notice('memories_dropped'), notice('other')], other: [notice('other'), notice(undefined)], none: [] as RunEventPayload[] };

  it('answers for a run appended today', async () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id, 'do the task');
    const claim = mustClaim(store, 'w1');
    expect(store.append(claim, journals.dropped).kind).toBe('ok');
    expect([await store.hasNoticeCode(run.id, 'memories_dropped'), await store.hasNoticeCode(run.id, 'other'), await store.hasNoticeCode(run.id, 'absent')]).toEqual([true, true, false]);
  });

  it('answers for runs written before the column', async () => {
    const { dbPath } = versionNineteen(journals);
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 10));
    expect(await Promise.all(['r1', 'r2', 'r3'].map((runId) => store.hasNoticeCode(runId, 'memories_dropped')))).toEqual([true, false, false]);
    expect(await Promise.all(['r1', 'r2', 'r3'].map((runId) => store.hasNoticeCode(runId, 'other')))).toEqual([true, true, false]);
  });
});
