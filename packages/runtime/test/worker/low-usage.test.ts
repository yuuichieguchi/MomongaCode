import { describe, expect, it } from 'vitest';
import { marginFloorFor } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import { inputTokensOf } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const WINDOW = 8192;
const TASK = `Echo something ${'padding '.repeat(500)}`;

const capabilities = () => capabilitiesFor(WINDOW, { maxOutputTokens: 1024 });

const estimatedInputTokens = async (): Promise<number> => {
  const env = await makeEnv({ capabilities: capabilities() });
  env.gateway.script.push(textStep('Done.'));
  env.enqueue(TASK);
  await env.runOnce(env.worker());
  const first = env.gateway.streams[0];
  if (first === undefined) throw new Error('the measuring run made no model call');
  return inputTokensOf(first.body);
};

describe('worker with a server that reports fewer input tokens than the estimate', () => {
  it('stops the run, before its tool calls run, when the reported count is far below the estimate', async () => {
    const env = await makeEnv({ capabilities: capabilities() });
    env.gateway.script.push(
      callsStep([{ callId: 'call_low_1', name: 'Echo', args: { value: 'a' } }], usageOf(10, 5)),
      textStep('Done.'),
    );
    const run = env.enqueue(TASK);

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('FAILED');
    expect(env.run(run.id).error?.code).toBe('input_truncated');
    expect(env.run(run.id).error?.message).toContain('likely truncated the input');
    expect(env.run(run.id).error?.message).toContain("server's context length");
    expect(env.run(run.id).error?.message).toContain('contextWindow');
    expect(env.gateway.streams).toHaveLength(1);
    expect(env.batches).toHaveLength(0);
  });

  it('names the reported count, the estimate and the margin it allows', async () => {
    const estimate = await estimatedInputTokens();
    const env = await makeEnv({ capabilities: capabilities() });
    env.gateway.script.push(textStep('Done.', { usage: usageOf(10, 5) }));
    const run = env.enqueue(TASK);

    await env.runOnce(env.worker());

    const message = env.run(run.id).error?.message ?? '';
    expect(message).toContain(`reported 10 input tokens`);
    expect(message).toContain(`${estimate} tokens`);
    expect(message).toContain(`${marginFloorFor(WINDOW)} tokens`);
  });

  it('completes when the reported count is exactly the estimate less the estimation margin', async () => {
    const estimate = await estimatedInputTokens();
    const env = await makeEnv({ capabilities: capabilities() });
    env.gateway.script.push(textStep('Done.', { usage: usageOf(estimate - marginFloorFor(WINDOW), 5) }));
    const run = env.enqueue(TASK);

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('stops when the reported count is one token below the estimate less the estimation margin', async () => {
    const estimate = await estimatedInputTokens();
    const env = await makeEnv({ capabilities: capabilities() });
    env.gateway.script.push(textStep('Done.', { usage: usageOf(estimate - marginFloorFor(WINDOW) - 1, 5) }));
    const run = env.enqueue(TASK);

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'input_truncated' } });
  });

  it('completes when the server reports more than the estimate', async () => {
    const estimate = await estimatedInputTokens();
    const env = await makeEnv({ capabilities: capabilities() });
    env.gateway.script.push(textStep('Done.', { usage: usageOf(estimate * 2, 5) }));
    const run = env.enqueue(TASK);

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});
