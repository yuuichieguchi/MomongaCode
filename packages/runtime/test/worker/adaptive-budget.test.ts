import { describe, expect, it } from 'vitest';
import { createMemoryPort } from '@momonga/runtime';
import type { Worker } from '@momonga/runtime';
import type { RunEventPayload, RunStatus } from '@momonga/protocol';
import type { Session } from '@momonga/store';
import { within } from './deferred.ts';
import { DEADLINE_MS, LEASE_MS, capabilitiesFor, createdRun, makeEnv, textOf, unavailableEvidenceRun } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, gated, textStep } from './scripts.ts';

const memoryWorker = (env: Env, id: string): Worker => env.worker(id, { memories: createMemoryPort({ store: env.store, settings: env.settings, evidenceRun: unavailableEvidenceRun }) });

type Past = { injected: number; used: number; dropped?: boolean; share?: number };

const DROPPED_NOTICE = '1 of 2 saved memories were left out of the context because of its budget';

const pastEvents = ({ injected, used, dropped = false, share = 1 / 4 }: Past, now: number): RunEventPayload[] => [
  { type: 'run.started', attempt: 1, now, pins: { modelAlias: 'fm', memoryShare: share }, mode: 'default' },
  ...(dropped ? [{ type: 'notice', level: 'warning', message: DROPPED_NOTICE, code: 'memories_dropped' } as RunEventPayload] : []),
  {
    type: 'context.contribution',
    items: Array.from({ length: injected }, (_unused, index) => ({ kind: 'memory' as const, id: `past-${index}`, contributed: index < used })),
  },
];

const finishPast = (env: Env, past: Past, session: Session = env.session, status: RunStatus = 'COMPLETED'): void => {
  env.clock.advance(1);
  const run = createdRun(env.store.createRunAndEnqueue(session.id, { input: 'Past work', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' }));
  const claim = env.seed(run.id, pastEvents(past, env.clock.now()), 'hold');
  const result = env.store.transition(claim, ['RUNNING'], status);
  if (result.kind !== 'ok') throw new Error(`past run could not finish: ${result.kind}`);
};

const finishPasts = (env: Env, count: number, past: Past): void => {
  for (let index = 0; index < count; index += 1) finishPast(env, past);
};

const shareOf = (env: Env, runId: string): unknown => env.ofType(runId, 'run.started')[0]?.pins['memoryShare'];

const adaptiveEnv = async (): Promise<Env> => {
  const env = await makeEnv({ mode: 'bypassPermissions' });
  env.settings.contextValue = { adaptiveBudget: true, autoCompact: true };
  return env;
};

const startRun = async (env: Env): Promise<string> => {
  env.gateway.script.push(textStep('Hello.'));
  const run = env.enqueue('Say hello', { history: 'fresh' });
  await env.runOnce(memoryWorker(env, `worker-${run.id}`));
  expect(env.run(run.id).status).toBe('COMPLETED');
  return run.id;
};

describe('adaptive memory budget at run start', () => {
  it('pins a share only when the setting is on, for the same window', async () => {
    const off = await makeEnv({ mode: 'bypassPermissions' });
    finishPasts(off, 20, { injected: 1, used: 0 });
    const on = await adaptiveEnv();
    finishPasts(on, 20, { injected: 1, used: 0 });

    expect(off.ofType(await startRun(off), 'run.started')[0]?.pins).not.toHaveProperty('memoryShare');
    expect(shareOf(on, await startRun(on))).toBe(1 / 8);
  });

  it('pins a quarter with an empty window', async () => {
    const env = await adaptiveEnv();
    expect(shareOf(env, await startRun(env))).toBe(1 / 4);
  });

  it('pins the unchanged quarter with nineteen unused runs', async () => {
    const env = await adaptiveEnv();
    finishPasts(env, 19, { injected: 1, used: 0 });
    expect(shareOf(env, await startRun(env))).toBe(1 / 4);
  });

  it('halves after twenty runs that left memory unused', async () => {
    const env = await adaptiveEnv();
    finishPasts(env, 20, { injected: 1, used: 0 });
    expect(shareOf(env, await startRun(env))).toBe(1 / 8);
  });

  it('doubles after twenty well-used runs in which memories were dropped', async () => {
    const env = await adaptiveEnv();
    finishPasts(env, 19, { injected: 1, used: 1 });
    finishPast(env, { injected: 1, used: 1, dropped: true });
    expect(shareOf(env, await startRun(env))).toBe(1 / 2);
  });

  it('compounds on the share pinned by the most recent run and clamps at one sixteenth', async () => {
    const env = await adaptiveEnv();
    finishPasts(env, 20, { injected: 1, used: 0, share: 1 / 16 });
    expect(shareOf(env, await startRun(env))).toBe(1 / 16);
  });

  it('reads only the last twenty runs', async () => {
    const env = await adaptiveEnv();
    finishPasts(env, 5, { injected: 1, used: 1 });
    finishPasts(env, 20, { injected: 1, used: 0 });
    expect(shareOf(env, await startRun(env))).toBe(1 / 8);
  });

  it('counts failed and stopped runs alike', async () => {
    const env = await adaptiveEnv();
    finishPasts(env, 10, { injected: 1, used: 0 });
    for (let index = 0; index < 5; index += 1) finishPast(env, { injected: 1, used: 0 }, env.session, 'FAILED');
    for (let index = 0; index < 5; index += 1) finishPast(env, { injected: 1, used: 0 }, env.session, 'STOPPED');
    expect(shareOf(env, await startRun(env))).toBe(1 / 8);
  });

  it('ignores the runs of another project', async () => {
    const env = await adaptiveEnv();
    const elsewhere = env.store.createSession({ cwd: `${env.project}-other`, env: {}, permissionMode: 'default', modelAlias: env.session.modelAlias });
    for (let index = 0; index < 20; index += 1) finishPast(env, { injected: 1, used: 0 }, elsewhere);
    expect(shareOf(env, await startRun(env))).toBe(1 / 4);
  });

  it('counts another session of the same project', async () => {
    const env = await adaptiveEnv();
    const sibling = env.store.createSession({ cwd: env.project, env: {}, permissionMode: 'default', modelAlias: env.session.modelAlias });
    for (let index = 0; index < 20; index += 1) finishPast(env, { injected: 1, used: 0 }, sibling);
    expect(shareOf(env, await startRun(env))).toBe(1 / 8);
  });

  it('leaves child runs out of the window, because memory metrics concern the root run', async () => {
    const env = await adaptiveEnv();
    finishPasts(env, 19, { injected: 1, used: 0 });
    env.clock.advance(1);
    const parent = createdRun(env.store.createRunAndEnqueue(env.session.id, { input: 'Parent', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' }));
    const parentClaim = env.seed(parent.id, pastEvents({ injected: 1, used: 0 }, env.clock.now()), 'hold');
    const created = env.store.createChildRun({ parentRunId: parent.id, parentCallId: 'call_child', input: 'Child', pins: {}, modelAlias: 'fm' });
    if (created.kind !== 'created') throw new Error(`child run was not created: ${created.kind}`);
    const childClaim = env.seed(created.run.id, pastEvents({ injected: 10, used: 10 }, env.clock.now()), 'hold');
    expect(env.store.transition(childClaim, ['RUNNING'], 'COMPLETED').kind).toBe('ok');
    expect(env.store.transition(parentClaim, ['RUNNING'], 'COMPLETED').kind).toBe('ok');

    expect(shareOf(env, await startRun(env))).toBe(1 / 8);
  });
});

describe('a window of runs pinned at the current share', () => {
  it('halves once after twenty low runs, then holds until twenty runs exist at the new share', async () => {
    const env = await adaptiveEnv();
    finishPasts(env, 20, { injected: 1, used: 0 });
    expect(shareOf(env, await startRun(env))).toBe(1 / 8);

    finishPasts(env, 18, { injected: 1, used: 0, share: 1 / 8 });
    expect(shareOf(env, await startRun(env))).toBe(1 / 8);

    expect(shareOf(env, await startRun(env))).toBe(1 / 16);
  });

  it('doubles once after twenty well-used runs with drops, then holds until twenty runs exist at the new share', async () => {
    const env = await adaptiveEnv();
    finishPasts(env, 19, { injected: 1, used: 1, share: 1 / 8 });
    finishPast(env, { injected: 1, used: 1, dropped: true, share: 1 / 8 });
    expect(shareOf(env, await startRun(env))).toBe(1 / 4);

    finishPasts(env, 18, { injected: 1, used: 1, dropped: true, share: 1 / 4 });
    expect(shareOf(env, await startRun(env))).toBe(1 / 4);

    expect(shareOf(env, await startRun(env))).toBe(1 / 2);
  });

  it('reads a run with no pinned share as the default quarter', async () => {
    const env = await adaptiveEnv();
    for (let index = 0; index < 20; index += 1) {
      env.clock.advance(1);
      const run = createdRun(env.store.createRunAndEnqueue(env.session.id, { input: 'Past work', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' }));
      const claim = env.seed(
        run.id,
        [
          { type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'default' },
          { type: 'context.contribution', items: [{ kind: 'memory', id: `past-${index}`, contributed: false }] },
        ],
        'hold',
      );
      expect(env.store.transition(claim, ['RUNNING'], 'COMPLETED').kind).toBe('ok');
    }
    expect(shareOf(env, await startRun(env))).toBe(1 / 8);
  });
});

describe('a pinned share', () => {
  it('survives a recovery although the window changed', async () => {
    const env = await adaptiveEnv();
    finishPasts(env, 20, { injected: 1, used: 0 });
    const before = env.gateway.streams.length;
    const blocked = gated(textStep('Done.'), 1);
    env.gateway.script.push(blocked);
    const run = env.enqueue('Work', { history: 'fresh' });
    const abandoned = env.runOnce(memoryWorker(env, 'worker-a'));
    await within(blocked.gate.reached.promise, 5_000, 'the stream to start');

    const sibling = env.store.createSession({ cwd: env.project, env: {}, permissionMode: 'default', modelAlias: env.session.modelAlias });
    for (let index = 0; index < 20; index += 1) finishPast(env, { injected: 1, used: 1, dropped: true }, sibling);
    env.clock.advance(LEASE_MS + 1);
    const recovering = env.runOnce(memoryWorker(env, 'worker-b'));
    await within(env.gateway.nthStream(before + 1), 5_000, 'the recovery re-send');
    blocked.gate.release.resolve();
    await within(recovering, 5_000, 'the recovering worker');
    await within(abandoned, 5_000, 'the abandoned worker to stop');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'run.started').map((event) => event.pins['memoryShare'])).toEqual([1 / 8, 1 / 8]);
    expect(env.fold(run.id).pins?.['memoryShare']).toBe(1 / 8);
  });

  it('is taken from the parent by a child run, even after the setting changed', async () => {
    const env = await adaptiveEnv();
    finishPasts(env, 20, { injected: 1, used: 0 });
    const parent = createdRun(env.store.createRunAndEnqueue(env.session.id, { input: 'Parent', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' }));
    const claim = env.seed(parent.id, pastEvents({ injected: 0, used: 0, share: 1 / 8 }, env.clock.now()), 'hold');
    const created = env.store.createChildRun({ parentRunId: parent.id, parentCallId: 'call_child', input: 'Child', pins: {}, modelAlias: 'fm' });
    if (created.kind !== 'created') throw new Error(`child run was not created: ${created.kind}`);
    expect(env.store.releaseLease(claim, { availableAt: env.clock.now() + 3_600_000 }).kind).toBe('ok');
    env.settings.contextValue = { adaptiveBudget: false, autoCompact: true };
    env.gateway.script.push(textStep('Child done.'));

    await env.runOnce(memoryWorker(env, 'worker-child'));

    expect(shareOf(env, created.run.id)).toBe(1 / 8);
  });

  it('decides how much memory reaches the model', async () => {
    const notes = [0, 1, 2, 3].map((index) => `note ${index} ${'keep the notes '.repeat(33).trim()}`);
    const recalledIn = async (adaptive: boolean): Promise<number> => {
      const env = await makeEnv({ mode: 'bypassPermissions', capabilities: capabilitiesFor(4000) });
      env.gateway.script.push(...notes.map((text, index) => callsStep([{ callId: `call_m_${index}`, name: 'MemorySave', args: { text, scope: 'user' } }])), textStep('Saved.'));
      env.enqueue('Remember this', { history: 'fresh' });
      await env.runOnce(memoryWorker(env, 'saver'));
      expect(env.store.memories.list()).toHaveLength(4);
      env.settings.contextValue = { adaptiveBudget: adaptive, autoCompact: true };
      finishPasts(env, 20, { injected: 1, used: 0 });
      const next = env.gateway.streams.length;
      await startRun(env);
      const input = env.gateway.streams[next]?.body.input;
      return (Array.isArray(input) ? input : []).map(textOf).join('\n').split('<memory id=').length - 1;
    };

    const fixed = await recalledIn(false);
    expect(fixed).toBeGreaterThan(0);
    expect(await recalledIn(true)).toBeLessThan(fixed);
  });
});
