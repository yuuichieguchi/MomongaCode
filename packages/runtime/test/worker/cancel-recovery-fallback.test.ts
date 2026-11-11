import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@momonga/runtime';
import type { ToolEnv } from '@momonga/runtime';
import type { Session } from '@momonga/store';
import type { ResultOutcome } from '@momonga/tools';
import { waitUntil, within } from './deferred.ts';
import { LEASE_MS, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import {
  ABANDONED_OUTPUT,
  RECONCILE_FAILURE_PREFIX,
  fatalStoreError,
  groupExists,
  recordingStore,
  seedStartedCalls,
  spawnMarkerHolder,
} from './cancel-fixture.ts';
import { REAL_PROCESS_TEST_TIMEOUT_MS, afterMicrotasks } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const BASH = { callId: 'call_b_1', name: 'Bash', kind: 'execute' as const, args: { command: 'sleep 30' } };
const MARK = { callId: 'call_m_1', name: 'Mark', args: { value: 'one' } };
const REMOTE = { callId: 'call_r_1', name: 'mcp__remote__write', args: { value: 'two' } };

const toolsWithout = (env: Env, ...names: string[]) => () => env.snapshotTools(env.toolbox.tools().filter((tool) => !names.includes(tool.name)));

const errorNotices = (env: Env, runId: string) => env.ofType(runId, 'notice').filter((notice) => notice.level === 'error');

describe('cancel recovery fallback', () => {
  it('a cancel whose policy build would fail reaches CANCELLED and reconciles the started call, because recovery builds no policy', async () => {
    const env = await makeEnv();
    const { run, keys } = await seedStartedCalls(env, [MARK]);
    const contexts: string[] = [];
    const worker = env.worker('worker-1', {
      tools: {
        policyFor: async () => {
          throw new Error('recovery must not build a tool policy');
        },
        recoveryContextFor: async (session: Session, options: { env: ToolEnv }) => {
          contexts.push(session.id);
          return { roots: [session.cwd], tmpDir: env.sessionTmpDir, env: options.env };
        },
      },
    });

    await env.settled(env.runOnce(worker), 'the cancel recovery');

    expect(contexts).toHaveLength(1);
    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.toolbox.reconciles).toEqual([keys[MARK.callId]]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: MARK.callId, outcome: 'already_applied', output: 'already marked one' })]);
    expect(errorNotices(env, run.id)).toEqual([]);
    expect(env.portCalls.abandon).toEqual([]);
    expect(env.store.idempotency.get(keys[MARK.callId] as string)?.s).toBe('COMPLETED');
  });

  it('a cancel still reconciles when the protected set would rethrow EIO from readEntry', async () => {
    const env = await makeEnv();
    const { run, keys } = await seedStartedCalls(env, [MARK]);
    const eio = Object.assign(new Error('EIO: injected readEntry failure'), { code: 'EIO' });
    const worker = env.worker('worker-1', {
      tools: {
        policyFor: async () => {
          throw eio;
        },
      },
    });

    await env.settled(env.runOnce(worker), 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.toolbox.reconciles).toEqual([keys[MARK.callId]]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: MARK.callId, outcome: 'already_applied' })]);
    expect(errorNotices(env, run.id)).toEqual([]);
  });

  it('a cancel where recoveryContextFor throws reaches CANCELLED, the process group is gone before CANCELLED, and the record is UNKNOWN', async () => {
    const env = await makeEnv();
    const { run, keys } = await seedStartedCalls(env, [BASH]);
    const key = keys[BASH.callId] as string;
    const pgid = spawnMarkerHolder(env, key);
    const store = recordingStore(env);
    const aliveAtCancel: Array<Promise<boolean>> = [];
    store.onCancelled.push(() => aliveAtCancel.push(groupExists(pgid)));
    const errors: unknown[] = [];
    const failure = new Error('the sandbox profile could not be built');
    const worker = env.worker('worker-1', {
      store,
      onError: (error) => errors.push(error),
      tools: {
        recoveryContextFor: async () => {
          throw failure;
        },
      },
    });

    await env.settled(env.runOnce(worker), 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(await Promise.all(aliveAtCancel)).toEqual([false]);
    expect(env.store.idempotency.get(key)?.s).toBe('UNKNOWN');
    expect(errors).toEqual([failure]);
    expect(errorNotices(env, run.id).map((notice) => notice.message)).toEqual([`${RECONCILE_FAILURE_PREFIX}the sandbox profile could not be built`]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: BASH.callId, outcome: 'unknown', output: ABANDONED_OUTPUT })]);
    const recovery = store.appends.filter((append) => append.types.includes('tool.reconciled'));
    expect(recovery.map((append) => append.types)).toEqual([['notice', 'tool.reconciled']]);
    expect(env.portCalls.abandon.map((call) => call.targets)).toEqual([[{ callId: BASH.callId, idemKey: key }]]);
  });

  it('the process group is gone before CANCELLED, including a child that closed fd 3', async () => {
    const env = await makeEnv();
    const { run, keys } = await seedStartedCalls(env, [BASH]);
    const key = keys[BASH.callId] as string;
    const pgid = spawnMarkerHolder(env, key, 'sleep 30 & exec 3>&-; wait');
    const store = recordingStore(env);
    const aliveAtCancel: Array<Promise<boolean>> = [];
    store.onCancelled.push(() => aliveAtCancel.push(groupExists(pgid)));
    const worker = env.worker('worker-1', {
      store,
      tools: {
        recoveryContextFor: async () => {
          throw new Error('recovery context unavailable');
        },
      },
    });

    await env.settled(env.runOnce(worker), 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(await Promise.all(aliveAtCancel)).toEqual([false]);
    expect(await groupExists(pgid)).toBe(false);
    expect(env.store.idempotency.get(key)?.s).toBe('UNKNOWN');
  });

  it('a cancel where recoveryToolSet throws reaches CANCELLED', async () => {
    const env = await makeEnv();
    const { run, keys } = await seedStartedCalls(env, [MARK]);
    const errors: unknown[] = [];
    const worker = env.worker('worker-1', {
      onError: (error) => errors.push(error),
      tools: {
        recoveryToolSet: async () => {
          throw new Error('builtin tools failed to load');
        },
      },
    });

    await env.settled(env.runOnce(worker), 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(errors).toHaveLength(1);
    expect(errorNotices(env, run.id).map((notice) => notice.message)).toEqual([`${RECONCILE_FAILURE_PREFIX}builtin tools failed to load`]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: MARK.callId, outcome: 'unknown', output: ABANDONED_OUTPUT })]);
    expect(env.toolbox.reconciles).toEqual([]);
    expect(env.store.idempotency.get(keys[MARK.callId] as string)?.s).toBe('UNKNOWN');
  });

  it('a cancel where envFor throws ConfigError reaches CANCELLED', async () => {
    const env = await makeEnv();
    const { run, keys } = await seedStartedCalls(env, [MARK]);
    const worker = env.worker('worker-1', {
      tools: {
        envFor: () => {
          throw new ConfigError('the user settings are invalid');
        },
      },
    });

    await env.settled(env.runOnce(worker), 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(errorNotices(env, run.id).map((notice) => notice.message)).toEqual([`${RECONCILE_FAILURE_PREFIX}the user settings are invalid`]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: MARK.callId, outcome: 'unknown', output: ABANDONED_OUTPUT })]);
    expect(env.batches).toEqual([]);
    expect(env.store.idempotency.get(keys[MARK.callId] as string)?.s).toBe('UNKNOWN');
  });

  it('a started call whose tool is absent from the recovery tool set is abandoned as unknown and is not sent to the batch', async () => {
    const env = await makeEnv();
    const { run, keys } = await seedStartedCalls(env, [MARK, REMOTE]);
    const worker = env.worker('worker-1');

    await env.settled(env.runOnce(worker), 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.batches.map((batch) => batch.calls.map((call) => call.callId))).toEqual([[MARK.callId]]);
    expect(env.portCalls.abandon.map((call) => call.targets)).toEqual([[{ callId: REMOTE.callId, idemKey: keys[REMOTE.callId] }]]);
    const reconciled = env.ofType(run.id, 'tool.reconciled').map((event) => [event.callId, event.outcome]);
    expect(reconciled).toEqual([
      [MARK.callId, 'already_applied'],
      [REMOTE.callId, 'unknown'],
    ]);
    expect(errorNotices(env, run.id)).toEqual([]);
    expect(env.store.idempotency.get(keys[REMOTE.callId] as string)?.s).toBe('UNKNOWN');
  });

  it('calls settled before runBatch failed are not recorded twice', async () => {
    const env = await makeEnv();
    const second = { callId: 'call_m_2', name: 'Mark', args: { value: 'two' } };
    const { run, keys } = await seedStartedCalls(env, [MARK, second]);
    const worker = env.worker('worker-1', {
      tools: {
        executor: {
          runBatch: async (input) => {
            const settled: ResultOutcome = { callId: MARK.callId, kind: 'result', reconciled: 'already_applied', idemKey: keys[MARK.callId] as string, result: { status: 'completed', output: 'already marked one' } };
            input.onOutcome?.(settled);
            throw new Error('the batch broke after one outcome');
          },
          release: (targets, options) => env.executor.release(targets, options),
          abandon: (targets, options) => env.executor.abandon(targets, options),
        },
      },
    });

    await env.settled(env.runOnce(worker), 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    const reconciled = env.ofType(run.id, 'tool.reconciled').map((event) => [event.callId, event.outcome]);
    expect(reconciled).toEqual([
      [MARK.callId, 'already_applied'],
      [second.callId, 'unknown'],
    ]);
    expect(errorNotices(env, run.id).map((notice) => notice.message)).toEqual([`${RECONCILE_FAILURE_PREFIX}the batch broke after one outcome`]);
  });

  it('abandon receives exactly the unsettled started calls', async () => {
    const env = await makeEnv();
    const second = { callId: 'call_m_2', name: 'Mark', args: { value: 'two' } };
    const { run, keys } = await seedStartedCalls(env, [MARK, second, REMOTE]);
    const worker = env.worker('worker-1', {
      tools: {
        executor: {
          runBatch: async (input) => {
            input.onOutcome?.({ callId: MARK.callId, kind: 'result', reconciled: 'already_applied', result: { status: 'completed', output: 'already marked one' } });
            throw new Error('the batch broke');
          },
          release: (targets, options) => env.executor.release(targets, options),
          abandon: (targets, options) => env.executor.abandon(targets, options),
        },
      },
    });

    await env.settled(env.runOnce(worker), 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.portCalls.abandon.map((call) => call.targets)).toEqual([
      [
        { callId: second.callId, idemKey: keys[second.callId] },
        { callId: REMOTE.callId, idemKey: keys[REMOTE.callId] },
      ],
    ]);
  });

  it('a started call without an idemKey is reported unknown without abandon', async () => {
    const env = await makeEnv();
    const { run } = await seedStartedCalls(env, [REMOTE], { cancel: false });
    env.clock.advance(1);
    const claim = env.store.claim('snapshotter');
    if (claim === null) throw new Error('expected to claim the run');
    const state = env.fold(run.id);
    const pending = state.pendingCalls[REMOTE.callId];
    if (pending === undefined) throw new Error('expected a pending call');
    const { idemKey: _dropped, ...withoutKey } = pending;
    const written = env.store.writeSnapshot(claim, state.lastSeq, { ...state, pendingCalls: { ...state.pendingCalls, [REMOTE.callId]: withoutKey } });
    expect(written).toEqual({ kind: 'ok' });
    env.clock.advance(LEASE_MS + 1);
    await env.cancel(run.id);

    await env.settled(env.runOnce(env.worker('worker-1')), 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.portCalls.abandon.flatMap((call) => call.targets)).toEqual([]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: REMOTE.callId, outcome: 'unknown', output: ABANDONED_OUTPUT })]);
  });

  it('cancel recovery never loads rules and never calls toolSet', async () => {
    const env = await makeEnv();
    const { run } = await seedStartedCalls(env, [MARK]);
    env.settings.rulesHook = async () => {
      throw new Error('rules must not be loaded during cancel recovery');
    };
    const worker = env.worker('worker-1', {
      tools: {
        toolSet: async () => {
          throw new Error('the full tool set must not be built during cancel recovery');
        },
      },
    });

    await env.settled(env.runOnce(worker), 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.settings.ruleReads).toBe(0);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: MARK.callId, outcome: 'already_applied' })]);
    expect(errorNotices(env, run.id)).toEqual([]);
    expect(env.batches.map((batch) => batch.rules)).toEqual([[]]);
  });

  it('lease loss during the fallback writes nothing more', async () => {
    const env = await makeEnv();
    const { run, keys } = await seedStartedCalls(env, [REMOTE]);
    const before = env.events(run.id).length;
    const store = recordingStore(env);
    const worker = env.worker('worker-1', {
      store,
      heartbeatMs: 5,
      tools: {
        recoveryToolSet: async ({ signal }: { signal: AbortSignal }) => {
          env.clock.advance(LEASE_MS + 1);
          if (env.store.claim('thief') === null) throw new Error('the thief could not take the run');
          await waitUntil(() => signal.aborted, 5_000, 'the recovery signal to abort on lease loss');
          return toolsWithout(env)();
        },
      },
    });

    await env.settled(env.runOnce(worker), 'the worker to give up the run');
    await afterMicrotasks();

    expect(env.portCalls.abandon).toEqual([]);
    expect(store.appends.filter((append) => append.runId === run.id)).toEqual([]);
    expect(env.events(run.id)).toHaveLength(before + 2);
    expect(env.store.idempotency.get(keys[REMOTE.callId] as string)?.s).toBe('PENDING');
  });

  it('shutdown during cancel recovery yields without writing', async () => {
    const env = await makeEnv();
    const { run, keys } = await seedStartedCalls(env, [REMOTE]);
    const before = env.events(run.id).length;
    const store = recordingStore(env);
    let shutdown: Promise<void> | undefined;
    const worker = env.worker('worker-1', {
      store,
      tools: {
        recoveryToolSet: async () => {
          shutdown = worker.abort('shutdown');
          return toolsWithout(env)();
        },
      },
    });

    await env.settled(env.runOnce(worker), 'the worker to yield');
    await within(shutdown ?? Promise.resolve(), 10_000, 'the shutdown');
    await afterMicrotasks();

    expect(env.portCalls.abandon).toEqual([]);
    expect(store.appends.filter((append) => append.runId === run.id)).toEqual([]);
    expect(env.events(run.id)).toHaveLength(before + 1);
    expect(env.run(run.id)).toMatchObject({ status: 'CANCELLING', leaseOwner: null });
    expect(env.store.idempotency.get(keys[REMOTE.callId] as string)?.s).toBe('PENDING');
  });

  it('a fatal store error in cancel recovery reaches onFatal', async () => {
    const env = await makeEnv();
    const { run } = await seedStartedCalls(env, [MARK]);
    const fatal = fatalStoreError();
    const fatals: Error[] = [];
    const worker = env.worker('worker-1', {
      onFatal: (error) => fatals.push(error),
      tools: {
        recoveryToolSet: async () => {
          throw fatal;
        },
      },
    });

    worker.start();
    await env.passTime(() => fatals.length > 0, 'onFatal');
    await env.settled(worker.stop(), 'the worker to stop');

    expect(fatals).toEqual([fatal]);
    expect(errorNotices(env, run.id)).toEqual([]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([]);
    expect(env.run(run.id).status).toBe('CANCELLING');
  });

  it('a fatal store error thrown by abandon reaches onFatal', async () => {
    const env = await makeEnv();
    const { run } = await seedStartedCalls(env, [REMOTE]);
    const fatal = fatalStoreError();
    const fatals: Error[] = [];
    const worker = env.worker('worker-1', {
      onFatal: (error) => fatals.push(error),
      tools: {
        executor: {
          runBatch: (input) => env.executor.runBatch(input),
          release: (targets, options) => env.executor.release(targets, options),
          abandon: async () => {
            throw fatal;
          },
        },
      },
    });

    worker.start();
    await env.passTime(() => fatals.length > 0, 'onFatal');
    await env.settled(worker.stop(), 'the worker to stop');

    expect(fatals).toEqual([fatal]);
    expect(errorNotices(env, run.id)).toEqual([]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([]);
    expect(env.run(run.id).status).toBe('CANCELLING');
  });

  it('abandon rejecting with a plain Error still reaches CANCELLED with exactly one error notice', async () => {
    const env = await makeEnv();
    const { run } = await seedStartedCalls(env, [REMOTE]);
    const errors: unknown[] = [];
    const worker = env.worker('worker-1', {
      onError: (error) => errors.push(error),
      tools: {
        executor: {
          runBatch: (input) => env.executor.runBatch(input),
          release: (targets, options) => env.executor.release(targets, options),
          abandon: async () => {
            throw new Error('lsof is not available');
          },
        },
      },
    });

    await env.settled(env.runOnce(worker), 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(errors).toHaveLength(1);
    expect(errorNotices(env, run.id).map((notice) => notice.message)).toEqual([`${RECONCILE_FAILURE_PREFIX}lsof is not available`]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: REMOTE.callId, outcome: 'unknown', output: ABANDONED_OUTPUT })]);
  });

  it('a throwing onError hook does not block cancellation', async () => {
    const env = await makeEnv();
    const { run } = await seedStartedCalls(env, [MARK]);
    const worker = env.worker('worker-1', {
      onError: () => {
        throw new Error('the hook exploded');
      },
      tools: {
        recoveryToolSet: async () => {
          throw new Error('builtin tools failed to load');
        },
      },
    });

    await env.settled(env.runOnce(worker), 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(errorNotices(env, run.id)).toHaveLength(1);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: MARK.callId, outcome: 'unknown' })]);
  });

  it('cancel recovery runs under its own signal: a RUNNING claim with cancelRequested and an aborted claim signal still reaps the started calls', async () => {
    const env = await makeEnv();
    const { run, keys } = await seedStartedCalls(env, [MARK], { cancel: false });
    let cancelPolls = 0;
    const cancels: Promise<unknown>[] = [];
    const store = {
      ...env.store,
      claim: (workerId: string) => {
        const claim = env.store.claim(workerId);
        if (claim !== null) cancels.push(env.store.requestCancel(claim.runId));
        return claim;
      },
      getRun: (id: string) => {
        cancelPolls += 1;
        return env.store.getRun(id);
      },
    };
    let recoverySignal: AbortSignal | undefined;
    const worker = env.worker('worker-1', {
      store,
      cancelPollMs: 2,
      tools: {
        recoveryToolSet: async ({ signal }: { signal: AbortSignal }) => {
          recoverySignal = signal;
          const seen = cancelPolls;
          await waitUntil(() => cancelPolls >= seen + 3, 5_000, 'the cancel poll to abort the claim signal');
          return env.snapshotTools(env.toolbox.tools());
        },
      },
    });

    await env.settled(env.runOnce(worker), 'the cancel recovery');
    await Promise.all(cancels);

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(recoverySignal?.aborted).toBe(false);
    expect(env.batches.map((batch) => batch.signal)).toEqual([recoverySignal]);
    expect(env.toolbox.reconciles).toEqual([keys[MARK.callId]]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: MARK.callId, outcome: 'already_applied' })]);
  });
});
