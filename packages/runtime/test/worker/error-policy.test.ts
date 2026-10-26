import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, callsStep, failedStep, textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

type ErrorFields = ConstructorParameters<typeof GatewayRequestError>[0];

const gatewayError = (fields: ErrorFields): GatewayRequestError => new GatewayRequestError(fields);

const thrown = (fields: ErrorFields): ScriptStep => ({ events: [], error: gatewayError(fields) });

const FIXED_RANDOM = (): number => 0.5;

const claimOnce = async (env: Env, worker: ReturnType<Env['worker']>): Promise<void> => {
  expect(await env.runOnce(worker)).toBe('yielded');
};

const delayOf = (env: Env, runId: string): number => env.run(runId).availableAt - env.clock.now();

const FATAL: [string, ErrorFields][] = [
  ['400 invalid_request', { status: 400, type: 'invalid_request', code: 'invalid_request', message: 'the request is malformed' }],
  ['401 authentication_failed', { status: 401, type: 'invalid_request', code: 'authentication_failed', message: 'the upstream key was rejected' }],
  ['401 missing_api_key', { status: 401, type: 'invalid_request', code: 'missing_api_key', message: 'no upstream key is configured' }],
  ['404 model_not_found', { status: 404, type: 'not_found', code: 'model_not_found', message: 'model fm does not exist' }],
  ['422 idempotency_key_reused', { status: 422, type: 'invalid_request', code: 'idempotency_key_reused', message: 'the key was used with another body' }],
  ['403 with an unknown code', { status: 403, type: 'invalid_request', code: 'forbidden_target', message: 'the target is forbidden' }],
];

const TIMEOUT: [string, () => ScriptStep][] = [
  ['a client deadline_exceeded', () => thrown({ status: 0, type: 'transport', code: 'deadline_exceeded', message: 'the deadline passed before sending' })],
  ['a gateway 504 deadline_exceeded', () => thrown({ status: 504, type: 'server_error', code: 'deadline_exceeded', message: 'the gateway deadline passed' })],
  ['a stream terminal response.failed deadline_exceeded', () => failedStep('deadline_exceeded')],
];

const REFUNDABLE: [string, ErrorFields][] = [
  ['gateway_unavailable proven not sent', { status: 0, type: 'transport', code: 'gateway_unavailable', message: 'connect ECONNREFUSED', provenNotSent: true }],
  ['503 gateway_closed', { status: 503, type: 'server_error', code: 'gateway_closed', message: 'the gateway is shutting down' }],
];

const TRANSIENT: [string, ErrorFields][] = [
  ['408', { status: 408, type: 'invalid_request', code: 'request_timeout', message: 'request timeout' }],
  ['409 idempotency_key_in_progress', { status: 409, type: 'invalid_request', code: 'idempotency_key_in_progress', message: 'the key is in flight' }],
  ['429', { status: 429, type: 'too_many_requests', code: 'rate_limited', message: 'slow down' }],
  ['500', { status: 500, type: 'server_error', code: 'internal_error', message: 'boom' }],
  ['502', { status: 502, type: 'server_error', code: 'http_502', message: 'bad gateway' }],
  ['gateway_unavailable possibly sent', { status: 0, type: 'transport', code: 'gateway_unavailable', message: 'socket reset', provenNotSent: false }],
  ['detached_run_expired', { status: 504, type: 'server_error', code: 'detached_run_expired', message: 'the detached run expired' }],
  ['unexpected_content_type', { status: 0, type: 'transport', code: 'unexpected_content_type', message: 'not an event stream' }],
];

describe('worker gateway error policy: fatal 4xx', () => {
  it.each(FATAL)('fails the run with the gateway code and message on %s', async (_label, fields) => {
    const env = await makeEnv();
    env.gateway.script.push(thrown(fields), textStep('never sent'));
    const run = env.enqueue('Work');

    await claimOnce(env, env.worker());

    const failed = env.run(run.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toEqual({ code: fields.code, message: fields.message });
    expect(env.gateway.streams).toHaveLength(1);
    expect(env.gateway.cancels).toEqual([]);
  });

  it('fails the run when capabilities rejects with model_not_found', async () => {
    const env = await makeEnv();
    const fields: ErrorFields = { status: 404, type: 'not_found', code: 'model_not_found', message: 'model fm does not exist' };
    env.gateway.capabilitiesHook = async () => {
      throw gatewayError(fields);
    };
    const run = env.enqueue('Work');

    await claimOnce(env, env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'model_not_found', message: 'model fm does not exist' } });
    expect(env.gateway.streams).toEqual([]);
  });

  it('passes the claim signal to capabilities', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Hello.'));
    env.enqueue('Work');

    await claimOnce(env, env.worker());

    expect(env.gateway.capabilitiesCalls).toHaveLength(1);
    expect(env.gateway.capabilitiesCalls[0]?.alias).toBe('fm');
    expect(env.gateway.capabilitiesCalls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails the run when countTokens rejects with authentication_failed', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('never sent'));
    env.gateway.countHook = async () => {
      throw gatewayError({ status: 401, type: 'invalid_request', code: 'authentication_failed', message: 'counting was rejected' });
    };
    const run = env.enqueue('Work');

    await claimOnce(env, env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'authentication_failed', message: 'counting was rejected' } });
    expect(env.gateway.streams).toEqual([]);
  });

  it('continues without compaction and warns when a proactive compact rejects with invalid_request', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(40_000) });
    const run = env.enqueue('Task one');
    const responded = (step: number, text: string): RunEventPayload => ({
      type: 'model.responded',
      step,
      attempt: 1,
      response: { status: 'completed', output: [assistantMessage(`msg_${step}`, text)], usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
    });
    env.seed(
      run.id,
      [
        responded(1, 'x'.repeat(100_000)),
        { type: 'user.message', text: 'question two' },
        responded(2, 'answer two'),
        { type: 'user.message', text: 'question three' },
        responded(3, 'answer three'),
        { type: 'user.message', text: 'question four' },
      ],
      'release',
    );
    env.gateway.script.push(textStep('Answer four.'));
    env.gateway.compactHook = async () => {
      throw gatewayError({ status: 400, type: 'invalid_request', code: 'invalid_request', message: 'compaction input is invalid' });
    };

    await claimOnce(env, env.worker());

    expect(env.gateway.compacts).toHaveLength(1);
    expect(env.run(run.id)).toMatchObject({ status: 'COMPLETED' });
    expect(env.gateway.streams).toHaveLength(1);
    expect(env.ofType(run.id, 'notice').map((event) => ({ level: event.level, message: event.message }))).toEqual([
      { level: 'warning', message: 'Compaction failed (invalid_request): compaction input is invalid; continuing without it' },
    ]);
  });
});

describe('worker gateway error policy: timeout', () => {
  it.each(TIMEOUT)('stops the run with timeout on %s', async (_label, failure) => {
    const env = await makeEnv();
    env.gateway.script.push(failure(), textStep('never sent'));
    const run = env.enqueue('Work');

    await claimOnce(env, env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect(env.gateway.streams).toHaveLength(1);
  });
});

describe('worker gateway error policy: refundable', () => {
  it.each(REFUNDABLE)('requeues with a refunded attempt on %s', async (_label, fields) => {
    const env = await makeEnv();
    env.gateway.script.push(thrown(fields), textStep('Recovered.'));
    const run = env.enqueue('Work');
    const worker = env.worker();

    await claimOnce(env, worker);

    const released = env.run(run.id);
    expect(released.status).toBe('QUEUED');
    expect(released.attempts).toBe(0);
    expect(released.leaseOwner).toBeNull();
    expect(released.availableAt).toBeGreaterThanOrEqual(env.clock.now());

    env.clock.set(released.availableAt);
    await claimOnce(env, worker);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('requeues with a refund when capabilities rejects with gateway_closed', async () => {
    const env = await makeEnv();
    let calls = 0;
    env.gateway.capabilitiesHook = async () => {
      calls += 1;
      if (calls === 1) throw gatewayError({ status: 503, type: 'server_error', code: 'gateway_closed', message: 'the gateway is shutting down' });
    };
    const run = env.enqueue('Work');

    await claimOnce(env, env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'QUEUED', attempts: 0 });
    expect(env.gateway.streams).toEqual([]);
  });
});

describe('worker gateway error policy: transient', () => {
  it.each(TRANSIENT)('requeues with a counted attempt on %s', async (_label, fields) => {
    const env = await makeEnv();
    env.gateway.script.push(thrown(fields), textStep('Recovered.'));
    const run = env.enqueue('Work');
    const worker = env.worker();

    await claimOnce(env, worker);

    const released = env.run(run.id);
    expect(released.status).toBe('QUEUED');
    expect(released.attempts).toBe(1);
    expect(released.availableAt).toBeGreaterThanOrEqual(env.clock.now());

    env.clock.set(released.availableAt);
    await claimOnce(env, worker);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('honours retryAfterMs when it exceeds the backoff', async () => {
    const env = await makeEnv();
    env.gateway.script.push(thrown({ status: 429, type: 'too_many_requests', code: 'rate_limited', message: 'slow down', retryAfterMs: 120_000 }));
    const run = env.enqueue('Work');

    await claimOnce(env, env.worker('worker-1', { random: FIXED_RANDOM }));

    expect(env.run(run.id).status).toBe('QUEUED');
    expect(delayOf(env, run.id)).toBe(120_000);
  });

  it('stops the run with timeout instead of requeueing at or after the deadline', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work', { deadlineAt: env.clock.now() + 60_000 });
    env.gateway.script.push(thrown({ status: 429, type: 'too_many_requests', code: 'rate_limited', message: 'slow down', retryAfterMs: 60_000 }));

    await claimOnce(env, env.worker('worker-1', { random: FIXED_RANDOM }));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
  });

  it('grows the backoff with the streak and resets it after a successful model response', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const failure = (): ScriptStep => thrown({ status: 500, type: 'server_error', code: 'internal_error', message: 'boom' });
    env.gateway.script.push(failure(), failure(), callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'one' } }]), failure());
    const run = env.enqueue('Work');
    const worker = env.worker('worker-1', { random: FIXED_RANDOM });

    await claimOnce(env, worker);
    const first = delayOf(env, run.id);
    expect(env.ofType(run.id, 'notice')).toHaveLength(1);
    env.clock.set(env.run(run.id).availableAt);

    await claimOnce(env, worker);
    const second = delayOf(env, run.id);
    expect(env.ofType(run.id, 'notice')).toHaveLength(1);
    env.clock.set(env.run(run.id).availableAt);

    await claimOnce(env, worker);
    const afterSuccess = delayOf(env, run.id);

    expect(env.ofType(run.id, 'model.responded')).toEqual([expect.objectContaining({ step: 1 })]);
    expect(env.run(run.id).status).toBe('QUEUED');
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(2 * first);
    expect(afterSuccess).toBe(first);
    expect(env.ofType(run.id, 'notice')).toHaveLength(2);
  });
});

describe('worker gateway error policy: stream_interrupted cap', () => {
  it('refunds the first three consecutive interruptions of a run and counts the fourth', async () => {
    const env = await makeEnv();
    const interrupted = (): ScriptStep => thrown({ status: 0, type: 'transport', code: 'stream_interrupted', message: 'the stream closed early' });
    env.gateway.script.push(interrupted(), interrupted(), interrupted(), interrupted(), interrupted());
    const run = env.enqueue('Work');
    const worker = env.worker('worker-1', { random: FIXED_RANDOM });
    const attempts: number[] = [];

    for (let cycle = 0; cycle < 5; cycle += 1) {
      await claimOnce(env, worker);
      const current = env.run(run.id);
      expect(current.status).toBe('QUEUED');
      attempts.push(current.attempts);
      env.clock.set(Math.max(env.clock.now(), current.availableAt));
    }

    expect(attempts).toEqual([0, 0, 0, 1, 2]);
    expect(env.gateway.streams).toHaveLength(5);
  });
});

describe('worker deadline at claim start', () => {
  it('stops a run claimed at or after its deadline before reading the tool set or capabilities', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work', { deadlineAt: env.clock.now() + 1_000 });
    env.clock.advance(1_000);
    let toolSetReads = 0;
    const worker = env.worker('worker-1', {
      tools: {
        toolSet: async () => {
          toolSetReads += 1;
          return env.snapshotTools(env.toolbox.tools());
        },
      },
    });

    await claimOnce(env, worker);

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect(toolSetReads).toBe(0);
    expect(env.gateway.capabilitiesCalls).toEqual([]);
    expect(env.gateway.streams).toEqual([]);
  });
});
