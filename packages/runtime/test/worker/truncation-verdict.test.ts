import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { usageOf } from '@momonga/testkit';
import { isSummaryRequest } from '../../src/worker/model-step.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const TASK = `Echo something ${'padding '.repeat(500)}`;

const crashingAfterTheResponseIsRecorded = (env: Env, runId: string): RuntimeStore => {
  const recorded = (): boolean => env.ofType(runId, 'model.responded').length > 0;
  let armed = true;
  const crash = (): never => {
    armed = false;
    throw new Error('the worker process was killed');
  };
  return {
    ...env.store,
    append: (claim, events) => {
      const result = env.store.append(claim, events);
      if (armed && recorded()) crash();
      return result;
    },
    transition: async (claim, from, to, patch, preceding) => {
      const result = await env.store.transition(claim, from, to, patch, preceding);
      if (armed && recorded()) crash();
      return result;
    },
  };
};

describe('one summary predicate', () => {
  it('treats a request that forbids tools as a summary request and any other as a work request', () => {
    expect(isSummaryRequest({ model: 'm', input: [], tool_choice: 'none' })).toBe(true);
    expect(isSummaryRequest({ model: 'm', input: [], tool_choice: 'auto' })).toBe(false);
    expect(isSummaryRequest({ model: 'm', input: [] })).toBe(false);
  });
});

describe('a truncated input is decided in the append that records the response', () => {
  it('never leaves a recorded response without its verdict when the worker dies right after the write', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(8192, { maxOutputTokens: 1024 }) });
    env.gateway.script.push(
      callsStep([{ callId: 'call_low_1', name: 'Echo', args: { value: 'a' } }], usageOf(10, 5)),
      textStep('Done.'),
    );
    const run = env.enqueue(TASK);

    await env.runOnce(env.worker('worker-1', { store: crashingAfterTheResponseIsRecorded(env, run.id) }));
    env.clock.advance(120_000);
    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'input_truncated' } });
    expect(env.batches).toHaveLength(0);
  });
});
