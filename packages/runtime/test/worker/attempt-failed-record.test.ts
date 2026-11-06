import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@momonga/protocol';
import { foldFacts } from '@momonga/reliability';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { callsStep, textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

const gatewayErrorStep = (fields: ConstructorParameters<typeof GatewayRequestError>[0]): ScriptStep => ({ events: [], error: new GatewayRequestError(fields) });

const REQUEUED: [string, () => ScriptStep, string][] = [
  ['a lost gateway connection, not refunded', () => gatewayErrorStep({ status: 0, type: 'transport', code: 'gateway_unavailable', message: 'the gateway connection was lost', provenNotSent: false }), 'gateway_unavailable'],
  [
    'a gateway_unavailable proven not sent, refunded',
    () => gatewayErrorStep({ status: 503, type: 'transport', code: 'gateway_unavailable', message: 'the gateway socket refused the connection', provenNotSent: true }),
    'gateway_unavailable',
  ],
  ['a gateway_closed 503, refunded', () => gatewayErrorStep({ status: 503, type: 'server_error', code: 'gateway_closed', message: 'the gateway is shutting down' }), 'gateway_closed'],
  ['a stream_interrupted, refunded', () => gatewayErrorStep({ status: 502, type: 'server_error', code: 'stream_interrupted', message: 'the gateway stream ended before a terminal event' }), 'stream_interrupted'],
  [
    'a deferral',
    () =>
      gatewayErrorStep({
        status: 429,
        type: 'too_many_requests',
        code: 'rate_limited',
        message: 'wait',
        retryAfterMs: 1000,
        deferred: true,
      } as ConstructorParameters<typeof GatewayRequestError>[0]),
    'rate_limited',
  ],
];

const FAILED = 'attempt.failed';

const typedEvents = (env: Env, runId: string): RunEvent[] => env.events(runId);

const failureRecords = (env: Env, runId: string) => typedEvents(env, runId).filter((event) => (event.type as string) === FAILED);

const precedingEachRequeue = (env: Env, runId: string): string[] => {
  const events = typedEvents(env, runId);
  return events.flatMap((event, index) => (event.type === 'run.status' && event.from === 'RUNNING' && event.to === 'QUEUED' ? [events[index - 1]?.type ?? 'none'] : []));
};

describe('the failing worker records attempt.failed before it yields to QUEUED (RunRecord FailedBeforeYield)', () => {
  it.each(REQUEUED)('after %s, attempt.failed {attempt, code, retryAt, limit} is the event immediately before RUNNING -> QUEUED', async (_label, failure, code) => {
    const env = await makeEnv();
    env.gateway.script.push(failure(), textStep('Recovered.'));
    const run = env.enqueue('Work');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('QUEUED');
    expect(failureRecords(env, run.id)).toEqual([expect.objectContaining({ type: FAILED, attempt: 1, code })]);
    expect(precedingEachRequeue(env, run.id)).toEqual([FAILED]);
    expect(Object.keys(failureRecords(env, run.id)[0] ?? {}).filter((key) => !['id', 'runId', 'sessionId', 'seq', 'step', 'leaseToken', 'createdAt'].includes(key)).sort()).toEqual(['attempt', 'code', 'limit', 'retryAt', 'type']);
  });

  it('a second failure on the next claim records the attempt of that claim, once per attempt', async () => {
    const env = await makeEnv();
    const lost = (): ScriptStep => gatewayErrorStep({ status: 0, type: 'transport', code: 'gateway_unavailable', message: 'the gateway connection was lost', provenNotSent: false });
    env.gateway.script.push(lost(), lost(), textStep('Recovered.'));
    const run = env.enqueue('Work');

    expect(await env.runOnce(env.worker())).toBe('yielded');
    env.clock.set(env.run(run.id).availableAt);
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');
    env.clock.set(env.run(run.id).availableAt);
    expect(await env.runOnce(env.worker('worker-3'))).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(failureRecords(env, run.id).map((event) => (event as unknown as { attempt: number }).attempt)).toEqual([1, 2]);
    expect(precedingEachRequeue(env, run.id)).toEqual([FAILED, FAILED]);
  });

  it('a graceful drain yields to QUEUED with no attempt.failed, while a failure in the same run does write one', async () => {
    const env = await makeEnv();
    let shutdown: Promise<void> | undefined;
    const first = env.worker('worker-1');
    env.toolbox.hooks.Echo = async () => {
      shutdown = first.abort('shutdown');
    };
    env.gateway.script.push(
      callsStep([{ callId: 'c1', name: 'Echo', args: { value: 'x' } }]),
      gatewayErrorStep({ status: 0, type: 'transport', code: 'gateway_unavailable', message: 'the gateway connection was lost', provenNotSent: false }),
      textStep('Done.'),
    );
    const run = env.enqueue('Echo then finish');

    await env.runOnce(first);
    await shutdown;
    expect(env.run(run.id).status).toBe('QUEUED');
    expect(failureRecords(env, run.id)).toEqual([]);

    await env.runOnce(env.worker('worker-2'));
    env.clock.set(env.run(run.id).availableAt);
    await env.runOnce(env.worker('worker-3'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(failureRecords(env, run.id)).toEqual([expect.objectContaining({ attempt: 2, code: 'gateway_unavailable' })]);
    const preceding = precedingEachRequeue(env, run.id);
    expect(preceding).toHaveLength(2);
    expect(preceding[0]).not.toBe(FAILED);
    expect(preceding[1]).toBe(FAILED);
  });
});

describe('a crash between attempt.failed and the yield (RunRecord FailedBeforeYield, carrier)', () => {
  it('leaves attempt.failed then attempt.lost from the takeover, and the fold makes one worker_failure episode at the attempt.failed instant', async () => {
    const env = await makeEnv();
    env.gateway.script.push(
      gatewayErrorStep({ status: 0, type: 'transport', code: 'gateway_unavailable', message: 'the gateway connection was lost', provenNotSent: false }),
      textStep('Recovered.'),
    );
    const run = env.enqueue('Work');
    const crash = new Error('the process died before the yield');
    const dying = new Proxy(env.store, {
      get: (target, key, receiver) => {
        if (key === 'release') return () => { throw crash; };
        const value = Reflect.get(target, key, receiver) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });

    await env.runOnce(env.worker('worker-1', { store: dying })).catch(() => undefined);
    expect(env.run(run.id).status).toBe('RUNNING');
    expect(failureRecords(env, run.id)).toEqual([expect.objectContaining({ attempt: 1, code: 'gateway_unavailable' })]);
    const failedAt = failureRecords(env, run.id)[0]?.createdAt as number;

    env.clock.set(env.run(run.id).leaseExpiresAt as number);
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    const records = typedEvents(env, run.id).filter((event) => ['attempt.failed', 'attempt.lost'].includes(event.type as string)).map((event) => event.type as string);
    expect(records).toEqual(['attempt.failed', 'attempt.lost']);
    const facts = foldFacts(typedEvents(env, run.id), {
      runId: run.id,
      rootRunId: run.id,
      sessionId: run.sessionId,
      status: 'COMPLETED',
      createdAt: run.createdAt,
      limits: {},
      step: 1,
      tokensTotal: 0,
      modelAlias: 'fm',
      mode: 'default',
      agent: 'build',
      origin: 'cli',
    });
    expect(facts.recoveries).toEqual([expect.objectContaining({ ordinal: 1, cause: 'worker_failure', failedAt, outcome: 'recovered' })]);
  });
});
