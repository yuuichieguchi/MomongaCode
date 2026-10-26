import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import { GatewayRequestError } from '@momonga/runtime';
import { usageOf } from '@momonga/testkit';
import { bodyDigest, finalSummaryInstruction, makeEnv, modelKey } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, failedStep, functionCallItem, textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

type ErrorFields = ConstructorParameters<typeof GatewayRequestError>[0];

const thrown = (fields: ErrorFields): ScriptStep => ({ events: [], error: new GatewayRequestError(fields) });

const REJECTED = { status: 400, type: 'invalid_request', code: 'context_length_exceeded', message: 'the prompt is longer than the model accepts' } satisfies ErrorFields;

type WrapUpPath = { label: string; reason: 'max_steps' | 'budget'; limits: Record<string, number>; first: () => ScriptStep };

const PATHS: WrapUpPath[] = [
  { label: 'max_steps', reason: 'max_steps', limits: { maxSteps: 1 }, first: () => callsStep([{ callId: 'call_w_1', name: 'Echo', args: { value: 'x' } }]) },
  {
    label: 'maxTotalTokens',
    reason: 'budget',
    limits: { maxTotalTokens: 100 },
    first: () => callsStep([{ callId: 'call_w_1', name: 'Echo', args: { value: 'x' } }], usageOf(100, 10)),
  },
];

const noticesOf = (env: Env, runId: string): string[] => env.ofType(runId, 'notice').map((event) => event.message);

const sameJson = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

describe('wrap-up request of the max_steps and maxTotalTokens paths', () => {
  it.for(PATHS)('sends no tools and counts the trailing user instruction on the $label path', async ({ reason, limits, first }) => {
    const env = await makeEnv();
    env.gateway.script.push(first(), textStep('Summary.'));
    const run = env.enqueue('Work', { limits });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: reason });
    const summary = env.gateway.streams[1];
    const instruction = { type: 'message', role: 'user', content: finalSummaryInstruction(reason) };
    expect(summary?.body.tool_choice).toBe('none');
    expect(summary?.body.tools ?? []).toEqual([]);
    expect(Array.isArray(summary?.body.input) ? summary.body.input.at(-1) : undefined).toEqual(instruction);
    const countedWithInstruction = env.gateway.counts.filter(
      (request) => Array.isArray(request.input) && sameJson(request.input.at(-1), instruction) && (request.tools ?? []).length === 0,
    );
    expect(countedWithInstruction.length).toBeGreaterThan(0);
    const [requested] = env.ofType(run.id, 'model.requested').filter((event) => event.step === 2);
    expect(sameJson(requested?.body, summary?.body)).toBe(true);
  });
});

describe('a 4xx on the wrap-up call stops the run with the original stop reason', () => {
  it.for(PATHS)('ends STOPPED with the $label reason and the gateway code in a notice', async ({ reason, limits, first }) => {
    const env = await makeEnv();
    env.gateway.script.push(first(), thrown(REJECTED), textStep('never sent'));
    const run = env.enqueue('Work', { limits });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: reason });
    expect(env.run(run.id).error).toBeUndefined();
    expect(noticesOf(env, run.id).some((message) => message.includes(REJECTED.code) && message.includes(REJECTED.message))).toBe(true);
    expect(env.gateway.streams).toHaveLength(2);
    expect(await env.runOnce(env.worker('worker-2'))).toBe('idle');
    expect(env.gateway.streams).toHaveLength(2);
  });

  it.for([
    { status: 400, type: 'invalid_request', code: 'invalid_request', message: 'the request is malformed' },
    { status: 413, type: 'invalid_request', code: 'payload_too_large', message: 'the body is too large' },
    { status: 422, type: 'invalid_request', code: 'unprocessable', message: 'the body cannot be processed' },
    { status: 401, type: 'invalid_request', code: 'authentication_failed', message: 'the upstream key was rejected' },
  ] satisfies ErrorFields[])('treats a $status $code on the wrap-up call as a stop, never max_tokens', async (fields) => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Echo', args: { value: 'x' } }]), thrown(fields));
    const run = env.enqueue('Work', { limits: { maxSteps: 1 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'max_steps' });
    expect(noticesOf(env, run.id).some((message) => message.includes(fields.code))).toBe(true);
  });

  it('computes the reason as max_steps when the step limit and the token budget are both reached', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Echo', args: { value: 'x' } }], usageOf(100, 10)), thrown(REJECTED));
    const run = env.enqueue('Work', { limits: { maxSteps: 1, maxTotalTokens: 100 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'max_steps' });
  });

  it('computes the reason as budget when the budget is reached before the step limit', async () => {
    const env = await makeEnv();
    env.gateway.script.push(
      callsStep([{ callId: 'call_w_1', name: 'Echo', args: { value: 'x' } }], usageOf(10, 5)),
      callsStep([{ callId: 'call_w_2', name: 'Echo', args: { value: 'y' } }], usageOf(100, 10)),
      thrown(REJECTED),
    );
    const run = env.enqueue('Work', { limits: { maxSteps: 5, maxTotalTokens: 100 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.gateway.streams).toHaveLength(3);
  });
});

describe('wrap-up dispositions that do not change', () => {
  it.for([
    { status: 429, type: 'too_many_requests', code: 'rate_limited', message: 'slow down' },
    { status: 408, type: 'invalid_request', code: 'request_timeout', message: 'request timeout' },
    { status: 409, type: 'invalid_request', code: 'idempotency_key_in_progress', message: 'the key is in flight' },
    { status: 500, type: 'server_error', code: 'internal_error', message: 'boom' },
  ] satisfies ErrorFields[])('requeues a $status on the wrap-up call as before', async (fields) => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Echo', args: { value: 'x' } }]), thrown(fields), textStep('Summary.'));
    const run = env.enqueue('Work', { limits: { maxSteps: 1 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('QUEUED');
  });

  it('requeues a stream-time model_error failure on the wrap-up call as before', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Echo', args: { value: 'x' } }]), failedStep('upstream_protocol_error', 'model_error'));
    const run = env.enqueue('Work', { limits: { maxSteps: 1 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('QUEUED');
  });

  it('still fails the run on a 400 at a normal step', async () => {
    const env = await makeEnv();
    env.gateway.script.push(thrown(REJECTED), textStep('never sent'));
    const run = env.enqueue('Work', { limits: { maxSteps: 1 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: REJECTED.code, message: REJECTED.message } });
  });

  it('still fails the run on a 400 from count_tokens while the wrap-up request is being built', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Echo', args: { value: 'x' } }]), textStep('never sent'));
    const run = env.enqueue('Work', { limits: { maxSteps: 1 } });
    env.gateway.countHook = async () => {
      if (env.gateway.streams.length >= 1 && env.toolbox.executions.length >= 1) throw new GatewayRequestError(REJECTED);
    };

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: REJECTED.code } });
    expect(env.gateway.streams).toHaveLength(1);
  });
});

describe('stop reason boundary of a rejected wrap-up call', () => {
  it.for([
    {
      label: 'a wrap-up at step 2 with maxSteps 2 after the budget was reached at step 1 stops with budget',
      limits: { maxSteps: 2, maxTotalTokens: 100 },
      steps: () => [callsStep([{ callId: 'call_b_1', name: 'Echo', args: { value: 'x' } }], usageOf(100, 10))],
      reason: 'budget',
      wrapUpStep: 2,
    },
    {
      label: 'a wrap-up at step 3 with maxSteps 2 stops with max_steps',
      limits: { maxSteps: 2 },
      steps: () => [
        callsStep([{ callId: 'call_m_1', name: 'Echo', args: { value: 'x' } }], usageOf(10, 5)),
        callsStep([{ callId: 'call_m_2', name: 'Echo', args: { value: 'y' } }], usageOf(10, 5)),
      ],
      reason: 'max_steps',
      wrapUpStep: 3,
    },
  ])('$label', async ({ limits, steps, reason, wrapUpStep }) => {
    const env = await makeEnv();
    env.gateway.script.push(...steps(), thrown(REJECTED));
    const run = env.enqueue('Work', { limits });

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'model.requested').map((event) => event.step).at(-1)).toBe(wrapUpStep);
    expect(env.fold(run.id).steps[wrapUpStep]?.summary).toBe(true);
    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: reason });
  });
});

describe('a crash during the wrap-up call', () => {
  const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
  const summaryBody = {
    model: 'fm',
    input: [{ type: 'message', role: 'user', content: finalSummaryInstruction('max_steps') }],
    tools: [],
    tool_choice: 'none',
    parallel_tool_calls: false,
    max_output_tokens: 4096,
    store: false,
    stream: true,
  };

  it.for([
    { label: 'a reply', reply: () => textStep('Summary after the crash.'), rejected: false },
    { label: 'a 400', reply: () => thrown(REJECTED), rejected: true },
  ])('resends the recorded wrap-up body unchanged and stops with max_steps when the resend gets $label', async ({ reply, rejected }) => {
    const env = await makeEnv();
    const run = env.enqueue('Work', { limits: { maxSteps: 1 } });
    env.seed(
      run.id,
      [
        { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [functionCallItem({ callId: 'call_c_1', name: 'Echo', args: { value: 'x' } })], usage: USAGE } },
        { type: 'tool.call', callId: 'call_c_1', providerCallId: 'call_c_1', name: 'Echo', kind: 'read', title: 'Echo x', rawInput: { value: 'x' } },
        { type: 'tool.completed', callId: 'call_c_1', status: 'completed', output: 'echo:x' },
        { type: 'model.requested', step: 2, attempt: 1, digest: bodyDigest(summaryBody), body: summaryBody },
      ],
      'crash',
    );
    env.gateway.script.push(reply());

    await env.runOnce(env.worker());

    expect(env.gateway.streams).toHaveLength(1);
    const resent = env.gateway.streams[0];
    expect(resent?.idempotencyKey).toBe(modelKey(run.id, 2));
    expect(bodyDigest(resent?.body)).toBe(bodyDigest(summaryBody));
    expect(env.fold(run.id).steps[2]?.summary).toBe(true);
    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'max_steps' });
    expect(env.run(run.id).error).toBeUndefined();
    expect(noticesOf(env, run.id).some((message) => message.includes(REJECTED.code) && message.includes(REJECTED.message))).toBe(rejected);
    expect(env.toolbox.executions).toEqual([]);
  });
});
