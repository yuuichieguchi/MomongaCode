import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { canonicalJson, migrate } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import { createFakeClock } from '@momonga/testkit';
import { encodeRunState } from '../../../store/src/codec.ts';
import { foldRunState, initialRunState } from '../../../store/src/fold.ts';
import { MIGRATIONS } from '../../../store/src/schema.ts';
import { START_MS, callEvent, makeStoreDir, openStoreAt, rawDb } from '../../../store/test/helpers.ts';
import { toolUsageWindowOf } from '../../src/worker/tool-usage-window.ts';
import { bodyWatchedStore } from './body-watched-store.ts';

const LAST_VERSION_BEFORE_THE_RECORD = 17;
const PROJECT = '/work/a';
const LOADER = 'LoadTools';

const tool = (name: string) => ({ type: 'function', name, description: name, parameters: { type: 'object', properties: {} } });

const loader = (catalog: readonly string[]) => ({
  type: 'function',
  name: LOADER,
  description: 'Loads deferred tools.',
  parameters: { type: 'object', properties: { names: { type: 'array', minItems: 1, items: { type: 'string', enum: [...catalog] } } }, required: ['names'] },
});

const requested = (step: number, tools: readonly unknown[]): RunEventPayload =>
  ({ type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { model: 'fm', input: [], tools: [...tools], tool_choice: 'auto' } }) as RunEventPayload;

const started = (deferred: readonly string[]): RunEventPayload => ({ type: 'run.started', attempt: 1, now: START_MS, pins: { token: { deferred: [...deferred] } }, mode: 'manual' });

const call = (callId: string, name: string): RunEventPayload => ({ type: 'tool.call', callId, providerCallId: callId, name, kind: 'read', title: name, rawInput: {} });

type OldRun = { id: string; session: string; parent: string | null; status: string; createdAt: number; events: RunEventPayload[] };

const OLD_RUNS: OldRun[] = [
  { id: 'r0', session: 's1', parent: null, status: 'STOPPED', createdAt: START_MS, events: [started(['Write'])] },
  {
    id: 'r1',
    session: 's1',
    parent: null,
    status: 'COMPLETED',
    createdAt: START_MS + 10,
    events: [
      started(['Counter', 'Write']),
      requested(1, [tool('Echo'), loader(['Counter'])]),
      call('call_load', LOADER),
      { type: 'tool.loaded', names: ['Counter'] },
      requested(2, [tool('Echo'), loader(['Counter']), tool('Counter')]),
    ],
  },
  {
    id: 'r2',
    session: 's2',
    parent: 'r1',
    status: 'COMPLETED',
    createdAt: START_MS + 11,
    events: [started(['Counter', 'Write']), requested(1, [tool('Grep')]), call('call_grep', 'Grep')],
  },
  { id: 'r3', session: 's1', parent: null, status: 'QUEUED', createdAt: START_MS + 20, events: [started(['Write']), requested(1, [tool('Echo')])] },
  { id: 'r4', session: 's1', parent: null, status: 'STOPPED', createdAt: START_MS + 21, events: [{ type: 'user.message', text: 'hello' }] },
];

const storeWrittenBeforeTheRecord = (): string => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= LAST_VERSION_BEFORE_THE_RECORD));
    const insertSession = db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    insertSession.run('s1', PROJECT, '{}', 'default', 'fm', START_MS);
    insertSession.run('s2', PROJECT, '{}', 'default', 'fm', START_MS);
    const insertRun = db.prepare(
      `INSERT INTO runs (id, session_id, ordinal, status, version, lease_owner, lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at, parent_run_id, parent_call_id)
       VALUES (?, ?, ?, ?, 1, NULL, 1, NULL, ?, 1, 0, 0, ?, '{}', ?, 0, ?, '{}', 0, ?, ?, ?)`,
    );
    const insertEvent = db.prepare('INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (?, ?, ?, ?, 1, ?, ?, ?)');
    OLD_RUNS.forEach((run, index) => {
      insertRun.run(
        run.id,
        run.session,
        index + 1,
        run.status,
        run.createdAt,
        run.createdAt + 3_600_000,
        canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        run.events.length,
        run.createdAt,
        run.parent,
        run.parent === null ? null : 'call_agent',
      );
      if (run.id === 'r3') {
        db.prepare('INSERT INTO snapshots (run_id, seq, state_json, created_at) VALUES (?, ?, ?, ?)').run(
          run.id,
          run.events.length,
          canonicalJson(encodeRunState({ ...initialRunState({ runId: run.id, sessionId: run.session }), lastSeq: run.events.length })),
          run.createdAt,
        );
      }
      run.events.forEach((payload, seq) => insertEvent.run(run.id, run.session, seq + 1, 'step' in payload ? payload.step : 0, run.createdAt, payload.type, canonicalJson(payload)));
    });
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  return dbPath;
};

describe('the offered-names record of runs written before it existed (person item 9, option 2)', () => {
  it('derives each old run\'s record once at the upgrade, from its request bodies, its pinned deferred set and its child runs', async () => {
    const store = openStoreAt(storeWrittenBeforeTheRecord(), createFakeClock(START_MS + 100));
    const { store: watched, reads } = bodyWatchedStore(store);

    const window = await toolUsageWindowOf(watched, PROJECT);

    expect(window).toEqual([
      { offered: ['Counter', 'Echo', 'Grep', LOADER, 'Write'], called: ['Grep', LOADER] },
      { offered: ['Write'], called: [] },
    ]);
    expect(reads.bodyReads).toEqual([]);
  });

  it('gives a run that was not finished at the upgrade its record at last_seq + 1, folded over its snapshot, and lets the next append land after it', async () => {
    const dbPath = storeWrittenBeforeTheRecord();
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 100));

    expect(rawDb(dbPath).prepare("SELECT last_seq FROM runs WHERE id = 'r3'").get()).toEqual({ last_seq: 3 });
    const loaded = store.load('r3');
    expect(loaded.snapshot?.seq).toBe(2);
    expect(loaded.tail.map((event) => [event.seq, event.type])).toEqual([[3, 'tool.offered']]);
    const folded = loaded.tail.reduce(foldRunState, loaded.snapshot?.state ?? initialRunState({ runId: 'r3', sessionId: 's1' }));
    expect(folded.offeredTools).toEqual(['Echo', 'Write']);

    const claim = store.claim('worker');
    if (claim === null) throw new Error('the queued run was not claimed');
    expect(claim.runId).toBe('r3');
    expect(store.append(claim, [callEvent('call_after')]).kind).toBe('ok');
    expect(store.readRunEvents('r3', 3, 10).map((event) => event.seq)).toEqual([4]);
    expect(rawDb(dbPath).prepare("SELECT last_seq FROM runs WHERE id = 'r3'").get()).toEqual({ last_seq: 4 });
  });

  it('gives a run that never recorded run.started no record', async () => {
    const dbPath = storeWrittenBeforeTheRecord();
    openStoreAt(dbPath, createFakeClock(START_MS + 100));

    expect(rawDb(dbPath).prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = 'r4' AND type = 'tool.offered'").get()).toEqual({ n: 0 });
    expect(rawDb(dbPath).prepare("SELECT last_seq FROM runs WHERE id = 'r4'").get()).toEqual({ last_seq: 1 });
  });
});
