import { FAKE_LEASE, createFakeKernelLock, fakePolicyFilesystem, hostFilesystemOf } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import type { GatewayPort } from '@momonga/runtime';
import type { RuntimeStore } from '@momonga/store';
import { createToolExecutor, defineTool } from '@momonga/tools';
import { deferred, waitUntil, within } from './deferred.ts';
import { DEADLINE_MS, LEASE_MS, START_MS, makeEnv, toolKey, createdRun } from './harness.ts';
import { pinnedStart } from './cancel-fixture.ts';
import type { Env } from './harness.ts';
import { MODEL_ALIAS, functionCallItem, requestedOffering, textStep } from './scripts.ts';

const untilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

const stall = defineTool<Record<string, unknown>>({
  name: 'Stall',
  description: 'A tool whose reconcile never settles',
  kind: 'edit',
  sideEffect: 'write',
  subjectKind: 'none',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
  timeoutMs: 60_000,
  title: () => 'Stall',
  subject: () => ({ kind: 'none', tool: 'Stall' }),
  execute: async () => ({ status: 'completed', output: 'stalled' }),
  reconcile: () => new Promise(() => undefined),
});

describe('worker cancel recovery with a hanging reconcile', () => {
  it('reaches CANCELLED with the call reconciled as unknown and never executed', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Stall');
    const key = toolKey(run.id, 1, 'call_s_1');
    const payloads: RunEventPayload[] = [
      pinnedStart(),
      requestedOffering(1, ['Stall']),
      {
        type: 'model.responded',
        step: 1,
        attempt: 1,
        response: {
          status: 'completed',
          output: [functionCallItem({ callId: 'call_s_1', name: 'Stall', args: { value: 'x' } })],
          usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 },
        },
      },
      { type: 'tool.call', callId: 'call_s_1', providerCallId: 'call_s_1', name: 'Stall', kind: 'edit', title: 'Stall', rawInput: { value: 'x' } },
      { type: 'tool.started', callId: 'call_s_1', idemKey: key },
    ];
    await env.seed(run.id, payloads, 'crash');
    env.store.idempotency.begin(key, { expiresAt: START_MS + 86_400_000, meta: { tool: 'Stall' } });
    expect((await env.cancel(run.id)).status).toBe('CANCELLING');
    const executor = createToolExecutor({ fs: hostFilesystemOf(fakePolicyFilesystem()), ...FAKE_LEASE,
      idempotency: env.store.idempotency,
      blobs: env.store.blobs,
      clock: env.clock,
      processMarkerDir: env.markers,
      callLockDir: env.callLocks,
      kernelLock: createFakeKernelLock({ inheritable: false }),
      onWarning: () => undefined,
      reconcileCapMs: 20,
      reconcileGraceMs: 20,
    });

    await within(env.runOnce(env.worker('worker-1', { tools: { executor }, toolList: () => [...env.toolbox.tools(), stall] })), 3_000, 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: 'call_s_1', outcome: 'unknown' })]);
    expect(env.store.idempotency.get(key)?.s).toBe('COMPLETED');
  });
});

const secondSessionRun = (env: Env) => {
  const other = env.store.createSession({ cwd: env.project, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, permissionMode: 'manual', modelAlias: MODEL_ALIAS });
  return createdRun(env.store.createRunAndEnqueue(other.id, { input: 'Say hello', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {} }));
};

const isFailureNotice = (payload: RunEventPayload): boolean => payload.type === 'notice' && payload.message.includes('load exploded');

describe('worker default error reporter', () => {
  it('appends the notice through the lease-checked append of the claim', async () => {
    const env = await makeEnv();
    const failing = env.enqueue('Fails to load');
    const appends: RunEventPayload[][] = [];
    const store: RuntimeStore = {
      ...env.store,
      load: (runId) => {
        if (runId === failing.id) throw new Error('load exploded');
        return env.store.load(runId);
      },
      append: (claim, payloads) => {
        appends.push([...payloads]);
        return env.store.append(claim, payloads);
      },
    };

    const worker = env.worker('worker-1', { store, idlePollMs: 10 });
    worker.start();
    await waitUntil(() => env.ofType(failing.id, 'notice').some((notice) => notice.message.includes('load exploded')), 2_000, 'the failure notice');
    await within(worker.stop(), 1_000, 'the worker to stop');

    expect(appends.filter((payloads) => payloads.some(isFailureNotice))).toHaveLength(1);
    const notice = env.ofType(failing.id, 'notice').find((event) => event.message.includes('load exploded'));
    expect(notice?.level).toBe('error');
  });

  it('writes nothing when the lease was lost before the report', async () => {
    const env = await makeEnv();
    const failing = env.enqueue('Fails to load');
    const healthy = secondSessionRun(env);
    env.gateway.script.push(textStep('Hello.'));
    let stolenAtSeq: number | undefined;
    const store: RuntimeStore = {
      ...env.store,
      load: (runId) => {
        if (runId === failing.id && stolenAtSeq === undefined) {
          env.clock.advance(LEASE_MS + 1);
          if (env.store.claim('worker-thief')?.runId !== failing.id) throw new Error('the thief did not steal the failing run');
          stolenAtSeq = env.run(failing.id).lastSeq;
          throw new Error('load exploded');
        }
        return env.store.load(runId);
      },
    };

    const worker = env.worker('worker-1', { store, idlePollMs: 10 });
    worker.start();
    await waitUntil(() => env.run(healthy.id).status === 'COMPLETED', 2_000, 'the healthy run to complete');
    await within(worker.stop(), 1_000, 'the worker to stop');

    expect(stolenAtSeq).toBeDefined();
    expect(env.run(failing.id).lastSeq).toBe(stolenAtSeq);
    expect(env.ofType(failing.id, 'notice').filter((notice) => notice.message.includes('load exploded'))).toEqual([]);
  });

  it('keeps polling without an unhandled rejection when the reporter itself fails', async () => {
    const env = await makeEnv();
    const failing = env.enqueue('Fails to load');
    const healthy = secondSessionRun(env);
    env.gateway.script.push(textStep('Hello.'));
    const store: RuntimeStore = {
      ...env.store,
      load: (runId) => {
        if (runId === failing.id) throw new Error('load exploded');
        return env.store.load(runId);
      },
      append: (claim, payloads) => {
        if (payloads.some(isFailureNotice)) throw new Error('reporter append exploded');
        return env.store.append(claim, payloads);
      },
      appendAsService: (runId, expectedVersion, to, payloads, patch) => {
        if (payloads.some(isFailureNotice)) throw new Error('reporter append exploded');
        return env.store.appendAsService(runId, expectedVersion, to, payloads, patch);
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const worker = env.worker('worker-1', { store, idlePollMs: 10 });
      worker.start();
      await waitUntil(() => env.run(healthy.id).status === 'COMPLETED', 2_000, 'the healthy run to complete');
      await within(worker.stop(), 1_000, 'the worker to stop');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });
});

describe('worker classification of stream errors', () => {
  it('appends no error notice when the cancel abort surfaces as TypeError terminated', async () => {
    const env = await makeEnv();
    const reached = deferred<void>();
    const gateway: GatewayPort = {
      ...env.gateway,
      stream: (_body, options) =>
        (async function* () {
          reached.resolve();
          await untilAborted(options.signal);
          throw new TypeError('terminated');
        })(),
    };
    const run = env.enqueue('Talk');
    const running = env.runOnce(env.worker('worker-1', { gateway, cancelPollMs: 10 }));
    await within(reached.promise, 2_000, 'the stream to start');
    await env.store.requestCancel(run.id);
    await within(running, 3_000, 'the worker to finish after cancel');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.level === 'error')).toEqual([]);
  });

  it('fails the run with internal_error on an AbortError raised without a cancel, a bug rather than a hop failure', async () => {
    const env = await makeEnv();
    const bug = new Error('a bug dressed as an abort');
    bug.name = 'AbortError';
    const gateway: GatewayPort = {
      ...env.gateway,
      stream: () =>
        (async function* () {
          throw bug;
        })(),
    };
    const run = env.enqueue('Talk');

    await env.runOnce(env.worker('worker-1', { gateway }));

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'internal_error', message: 'a bug dressed as an abort' } });
  });
});
