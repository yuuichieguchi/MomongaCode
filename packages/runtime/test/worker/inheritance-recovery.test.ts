import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import type { RuntimeStore } from '@momonga/store';
import { foldRunState, initialRunState } from '@momonga/store';
import { within } from './deferred.ts';
import { LEASE_MS, makeEnv, modelKey } from './harness.ts';
import type { Env } from './harness.ts';
import { gated, textStep } from './scripts.ts';
import { envNeutralJson, firstConversation, inheritedEventOf, settle } from './inheritance-support.ts';

type Reads = { inheritContext: number; loadPrevious: number; readPrevious: number };

const watchedStore = (env: Env, previousRunId: string, reads: Reads): RuntimeStore => ({
  ...env.store,
  inheritContext: (claim, options) => {
    reads.inheritContext += 1;
    return env.store.inheritContext(claim, options);
  },
  load: (runId) => {
    if (runId === previousRunId) reads.loadPrevious += 1;
    return env.store.load(runId);
  },
  readRunEvents: (runId, afterSeq, limit) => {
    if (runId === previousRunId) reads.readPrevious += 1;
    return env.store.readRunEvents(runId, afterSeq, limit);
  },
});

const answered = async (env: Env, task: string, answer: string): Promise<string> => {
  env.gateway.script.push(textStep(answer));
  const run = env.enqueue(task);
  expect((await settle(env, run.id)).status).toBe('COMPLETED');
  return run.id;
};

describe('recovery of an inheriting run killed during its first model call', () => {
  it('re-sends the journaled body without reading run 1 or inheriting again', async () => {
    const env = await makeEnv();
    const first = await answered(env, 'Say hello', 'Hello there.');
    const blocked = gated(textStep('Recovered answer.'), 4);
    env.gateway.script.push(blocked);
    const second = env.enqueue('And again');
    const abandoned = env.runOnce(env.worker('worker-a'));
    await within(blocked.gate.reached.promise, 5_000, 'the first stream of run 2 to start');
    const [requested] = env.ofType(second.id, 'model.requested');
    if (requested === undefined) throw new Error('expected model.requested');

    const reads: Reads = { inheritContext: 0, loadPrevious: 0, readPrevious: 0 };
    env.clock.advance(LEASE_MS + 1);
    const recovering = env.runOnce(env.worker('worker-b', { store: watchedStore(env, first, reads) }));
    await within(env.gateway.nthStream(1), 5_000, 'the recovery re-send');
    blocked.gate.release.resolve();
    await within(recovering, 5_000, 'the recovering worker');
    await within(abandoned, 5_000, 'the abandoned worker to stop');

    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(reads).toEqual({ inheritContext: 0, loadPrevious: 0, readPrevious: 0 });
    const [original, resent] = env.gateway.streams.slice(-2);
    expect(resent?.idempotencyKey).toBe(original?.idempotencyKey);
    expect(resent?.idempotencyKey).toBe(modelKey(second.id, 1, 1));
    expect(canonicalJson(resent?.body)).toBe(canonicalJson(original?.body));
    expect(resent?.body).toEqual(requested.body);
    expect(env.events(second.id).filter((event) => event.type === 'context.inherited')).toHaveLength(1);
    expect(env.ofType(second.id, 'model.requested').filter((event) => event.step === 1)).toHaveLength(1);
    expect(firstConversation(env, second.id)).toEqual([
      ['user', 'Say hello'],
      ['assistant', 'Hello there.'],
      ['user', 'And again'],
    ]);
  });

  it('rebuilds the same first request as an uninterrupted run after a crash right after the inherit append', async () => {
    const control = await makeEnv();
    await answered(control, 'Say hello', 'Hello there.');
    control.gateway.script.push(textStep('Answer.'));
    const controlRun = control.enqueue('And again');
    await settle(control, controlRun.id);

    const env = await makeEnv();
    const first = await answered(env, 'Say hello', 'Hello there.');
    let failed = false;
    const tools = {
      toolSet: async () => {
        if (!failed) {
          failed = true;
          throw new Error('the tool set is unavailable');
        }
        return env.snapshotTools(env.toolbox.tools());
      },
    };
    env.gateway.script.push(textStep('Answer.'));
    const second = env.enqueue('And again');
    await env.runOnce(env.worker('worker-a', { tools }));
    expect(env.run(second.id).status).toBe('QUEUED');
    expect(env.ofType(second.id, 'model.requested')).toEqual([]);
    inheritedEventOf(env, second.id);

    const reads: Reads = { inheritContext: 0, loadPrevious: 0, readPrevious: 0 };
    env.clock.advance(120_000);
    await env.runOnce(env.worker('worker-b', { tools, store: watchedStore(env, first, reads) }));

    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(reads).toEqual({ inheritContext: 0, loadPrevious: 0, readPrevious: 0 });
    const [rebuilt] = env.ofType(second.id, 'model.requested');
    const [uninterrupted] = control.ofType(controlRun.id, 'model.requested');
    expect(envNeutralJson(env, (rebuilt?.body as { input: unknown }).input)).toBe(envNeutralJson(control, (uninterrupted?.body as { input: unknown }).input));
  });

  it('reproduces the same state from a full fold when the snapshots are dropped', async () => {
    const env = await makeEnv();
    await answered(env, 'Say hello', 'Hello there.');
    const second = await answered(env, 'And again', 'Again.');
    const withSnapshot = env.store.load(second);
    const initial = initialRunState({ runId: second, sessionId: env.session.id });
    const before = withSnapshot.tail.reduce(foldRunState, withSnapshot.snapshot?.state ?? initial);
    expect(before.inherited).toBeDefined();
    expect(before.taskSeq).toBe(3);

    env.raw().prepare('DELETE FROM snapshots WHERE run_id = ?').run(second);
    const replayed = env.store.load(second);

    expect(replayed.snapshot).toBeUndefined();
    expect(replayed.tail.reduce(foldRunState, initial)).toEqual(before);
  });
});
