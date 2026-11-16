import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NEVER_CANCELLED, PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import type { RetentionPurge, RuntimeStore } from '@momonga/store';
import { cfgNames } from '../../../test/formal/cfg-names.ts';
import { cancelToEnd, enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const model = cfgNames(path.resolve(import.meta.dirname, '..', '..', '..', 'specs', 'tla'), 'Retention');

const DAY_MS = 86_400_000;
const PERIOD_MS = 30 * DAY_MS;
const STORES = ['traces', 'gateway', 'observer'] as const;

type Step = 'age' | 'half' | 'activity' | 'queue' | 'end' | 'sweep' | 'failingSweep';

const STEPS: readonly Step[] = ['age', 'half', 'activity', 'queue', 'end', 'sweep', 'failingSweep'];

const sequences = (length: number): Step[][] => {
  let all: Step[][] = [[]];
  for (let index = 0; index < length; index += 1) all = all.flatMap((sequence) => STEPS.map((step) => [...sequence, step]));
  return all.filter((sequence) => sequence.includes('sweep') || sequence.includes('failingSweep'));
};

const world = async () => {
  const { store, clock, dbPath } = harness();
  const parent = newSession(store, '/work/a');
  await enqueue(store, parent.id);
  const claim = mustClaim(store, 'w-parent');
  const spawned = await store.createChildRun({ parentRunId: claim.runId, parentCallId: 'call-1', input: 'child task', pins: {}, model: 'fm' });
  if (spawned.kind !== 'created') throw new Error(`expected a child run, got ${spawned.kind}`);
  expect((await store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
  await cancelToEnd(store, spawned.run.id);
  const runsOf = new Map<string, string[]>([
    [parent.id, [claim.runId]],
    [spawned.session.id, [spawned.run.id]],
  ]);
  const lastActivity = new Map<string, number>([
    [parent.id, clock.now()],
    [spawned.session.id, clock.now()],
  ]);
  return { store, clock, dbPath, sessions: [parent.id, spawned.session.id] as const, runsOf, lastActivity };
};

const queuedOrRunning = (store: RuntimeStore, runIds: readonly string[]): boolean => runIds.some((runId) => ['QUEUED', 'RUNNING'].includes(store.getRun(runId)?.status ?? ''));

describe('retentionSweep on the cases of specs/tla/Retention.tla, through the real store', () => {
  it('the design configuration checks the invariants these cases run', () => {
    expect(model.invariants).toEqual(expect.arrayContaining(['ActiveNotDeleted', 'NoEarlyDelete', 'NoDanglingSessionRef', 'NoUncoveredDangling', 'OneSetting', 'NoLiveReferenceDeleted']));
  });

  it('a parent and its child session, under every sequence of ageing, new activity, a queued run, its end, and sweeps whose purges succeed or fail: no session with a run that has not ended or with a live child is deleted, none is deleted before its last activity is one period old, parent and child go together, every store is purged with the one cutoff of the sweep, and every deleted run reaches every store purge', async () => {
    const problems: string[] = [];
    for (const sequence of sequences(3)) {
      const scene = await world();
      const { store, clock } = scene;
      const label = sequence.join(',');
      const purgedBy = new Map<string, Set<string>>(STORES.map((name) => [name, new Set<string>()]));
      const deleted = new Set<string>();
      for (const step of sequence) {
        if (step === 'age') clock.advance(PERIOD_MS + DAY_MS);
        else if (step === 'half') clock.advance(PERIOD_MS / 2);
        else if (step === 'activity' || step === 'queue') {
          const session = scene.sessions[step === 'activity' ? 0 : 1];
          if (store.getSession(session) === undefined) continue;
          const run = await enqueue(store, session, step);
          scene.runsOf.get(session)?.push(run.id);
          scene.lastActivity.set(session, clock.now());
          if (step === 'activity') await cancelToEnd(store, run.id);
        } else if (step === 'end') {
          for (const session of scene.sessions) {
            for (const runId of scene.runsOf.get(session) ?? []) {
              if (store.getRun(runId)?.status !== 'QUEUED') continue;
              await cancelToEnd(store, runId);
              scene.lastActivity.set(session, clock.now());
            }
          }
        } else {
          const before = scene.sessions.filter((session) => store.getSession(session) !== undefined);
          const cutoffs = new Set<number>();
          const purges: RetentionPurge[] = STORES.map((name) => async (runIds, cutoffMs) => {
            cutoffs.add(cutoffMs);
            if (step === 'failingSweep' && name === 'gateway') throw new Error('the gateway did not answer');
            for (const runId of runIds) purgedBy.get(name)?.add(runId);
          });
          const swept = store.retention.sweep({ periodMs: PERIOD_MS, purges }, NEVER_CANCELLED);
          if (step === 'failingSweep') await swept.catch(() => undefined);
          else await swept;
          if ([...cutoffs].some((cutoff) => cutoff !== clock.now() - PERIOD_MS)) problems.push(`${label}: OneSetting, cutoffs ${[...cutoffs].join(',')}`);
          for (const session of before) {
            if (store.getSession(session) !== undefined) continue;
            deleted.add(session);
            if ((scene.lastActivity.get(session) ?? 0) + PERIOD_MS > clock.now()) problems.push(`${label}: NoEarlyDelete, ${session}`);
          }
        }
        const [parent, child] = scene.sessions;
        if ((store.getSession(parent) === undefined) !== (store.getSession(child) === undefined)) problems.push(`${label} after ${step}: NoDanglingSessionRef`);
        for (const session of scene.sessions) {
          if (store.getSession(session) === undefined && queuedOrRunning(store, scene.runsOf.get(session) ?? [])) problems.push(`${label} after ${step}: NoLiveReferenceDeleted, ${session}`);
        }
      }
      const pending = (rawDb(scene.dbPath).prepare('SELECT COUNT(*) AS n FROM retention_sweeps').get() as { n: number }).n;
      if (pending === 0) {
        for (const session of deleted) {
          for (const runId of scene.runsOf.get(session) ?? []) {
            for (const [name, purged] of purgedBy) if (!purged.has(runId)) problems.push(`${label}: NoUncoveredDangling, ${runId} never reached the ${name} purge`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
