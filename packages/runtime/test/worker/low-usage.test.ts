import { describe, expect, it } from 'vitest';
import { ESTIMATED_ERROR_BOUND_RATIO, marginFloorFor } from '@momonga/protocol';
import type { StreamEvent } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import { inputTokensOf } from './fake-gateway.ts';
import type { ScriptStep } from './fake-gateway.ts';
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

const LARGE_TASK = `Echo something ${'padding '.repeat(2200)}`;

describe('worker with an estimated token count', () => {
  const measured = async (): Promise<number> => {
    const env = await makeEnv({ capabilities: capabilities() });
    env.gateway.countMethod = 'estimated';
    env.gateway.script.push(textStep('Done.'));
    env.enqueue(LARGE_TASK);
    await env.runOnce(env.worker());
    const first = env.gateway.streams[0];
    if (first === undefined) throw new Error('the measuring run made no model call');
    return inputTokensOf(first.body);
  };

  it('does not stop when the server reports 85 percent of the estimate, which is inside the documented bound of an estimated count', async () => {
    const estimate = await measured();
    const env = await makeEnv({ capabilities: capabilities() });
    env.gateway.countMethod = 'estimated';
    env.gateway.script.push(textStep('Done.', { usage: usageOf(Math.floor(estimate * 0.85), 5) }));
    const run = env.enqueue(LARGE_TASK);

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('stops when the server reports half of the estimate, well below the documented bound plus the margin floor', async () => {
    const estimate = await measured();
    const env = await makeEnv({ capabilities: capabilities() });
    env.gateway.countMethod = 'estimated';
    env.gateway.script.push(textStep('Done.', { usage: usageOf(Math.floor(estimate * 0.5), 5) }));
    const run = env.enqueue(LARGE_TASK);

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'input_truncated' } });
  });

  describe('over two steps, the second built on what the server reported for the first', () => {
    const script = (usage1: 'auto' | number, usage2: 'auto' | number) => [
      callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'a'.repeat(400) } }], usage1 === 'auto' ? 'auto' : usageOf(usage1, 5)),
      textStep('Done.', { usage: usage2 === 'auto' ? 'auto' : usageOf(usage2, 5) }),
    ];

    const measuredBoth = async (): Promise<[number, number]> => {
      const env = await makeEnv({ capabilities: capabilities() });
      env.gateway.countMethod = 'estimated';
      env.gateway.script.push(...script('auto', 'auto'));
      env.enqueue(LARGE_TASK);
      await env.runOnce(env.worker());
      const [first, second] = env.gateway.streams;
      if (first === undefined || second === undefined) throw new Error('the measuring run made fewer than two model calls');
      return [inputTokensOf(first.body), inputTokensOf(second.body)];
    };

    it.each([
      ['85 percent of the estimate at both steps, which is inside the documented bound', 0.85, 'COMPLETED'],
      ['half of the estimate at both steps, which is well below it', 0.5, 'FAILED'],
    ] as const)('with the server reporting %s ends %s', async (_label, share, status) => {
      const [first, second] = await measuredBoth();
      const env = await makeEnv({ capabilities: capabilities() });
      env.gateway.countMethod = 'estimated';
      env.gateway.script.push(...script(Math.floor(first * share), Math.floor(second * share)));
      const run = env.enqueue(LARGE_TASK);

      await env.runOnce(env.worker());

      expect(env.run(run.id).status).toBe(status);
      if (status === 'FAILED') expect(env.run(run.id).error?.code).toBe('input_truncated');
    });
  });

  it('allows exactly the documented bound of the estimated part plus the margin floor, and stops one token below', async () => {
    const estimate = await measured();
    const allowed = Math.ceil(ESTIMATED_ERROR_BOUND_RATIO * estimate) + marginFloorFor(WINDOW);
    const at = await makeEnv({ capabilities: capabilities() });
    at.gateway.countMethod = 'estimated';
    at.gateway.script.push(textStep('Done.', { usage: usageOf(estimate - allowed, 5) }));
    const atRun = at.enqueue(LARGE_TASK);
    await at.runOnce(at.worker());
    expect(at.run(atRun.id).status).toBe('COMPLETED');

    const below = await makeEnv({ capabilities: capabilities() });
    below.gateway.countMethod = 'estimated';
    below.gateway.script.push(textStep('Done.', { usage: usageOf(estimate - allowed - 1, 5) }));
    const belowRun = below.enqueue(LARGE_TASK);
    await below.runOnce(below.worker());
    expect(below.run(belowRun.id)).toMatchObject({ status: 'FAILED', error: { code: 'input_truncated' } });
  });
});

const answeredByFallback =(step: ScriptStep, target: string): ScriptStep => ({
  ...step,
  events: step.events.map(
    (event): StreamEvent =>
      event.type === 'response.completed'
        ? {
            ...event,
            response: {
              ...event.response,
              momonga: {
                alias: 'fm',
                target,
                attempts: 2,
                fallbackFrom: ['primary'],
                fallbackCauses: [{ target: 'primary', code: 'upstream_error', message: 'primary is down' }],
                usageSource: 'reported',
              },
            },
          }
        : event,
  ),
});

describe('worker with a fallback target that answered', () => {
  it('does not stop when the target that answered counts fewer tokens than the primary by design', async () => {
    const estimate = await estimatedInputTokens();
    const env = await makeEnv({ capabilities: capabilities() });
    env.gateway.countScaleByTarget.set('secondary', 0.1);
    env.gateway.script.push(answeredByFallback(textStep('Done.', { usage: usageOf(Math.ceil(estimate * 0.1), 5) }), 'secondary'));
    const run = env.enqueue(TASK);

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.counts.some((request) => request.momonga?.target === 'secondary')).toBe(true);
  });

  it('counts the input for the target that answered, not for the primary', async () => {
    const env = await makeEnv({ capabilities: capabilities() });
    env.gateway.script.push(answeredByFallback(textStep('Done.'), 'secondary'));
    env.enqueue(TASK);

    await env.runOnce(env.worker());

    const targeted = env.gateway.counts.filter((request) => request.momonga?.target !== undefined);
    expect(targeted.length).toBeGreaterThan(0);
    expect(targeted.every((request) => request.momonga?.target === 'secondary')).toBe(true);
  });

  it('still stops when the target that answered reports fewer tokens than its own count less the margin', async () => {
    const env = await makeEnv({ capabilities: capabilities() });
    env.gateway.script.push(answeredByFallback(textStep('Done.', { usage: usageOf(10, 5) }), 'secondary'));
    const run = env.enqueue(TASK);

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'input_truncated' } });
  });

  it('keeps the calibration of the primary untouched by what a fallback target reported', async () => {
    const estimate = await estimatedInputTokens();
    const env = await makeEnv({ capabilities: capabilities() });
    env.gateway.countScaleByTarget.set('secondary', 0.1);
    env.gateway.script.push(
      answeredByFallback(callsStep([{ callId: 'call_f_1', name: 'Echo', args: { value: 'a' } }], usageOf(Math.ceil(estimate * 0.1), 5)), 'secondary'),
      textStep('Done.'),
    );
    const run = env.enqueue(TASK);

    await env.runOnce(env.worker());
    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});
