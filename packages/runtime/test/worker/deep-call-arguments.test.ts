import { describe, expect, it } from 'vitest';
import type { FunctionCallItem } from '@momonga/protocol';
import { makeEnv } from './harness.ts';
import { outputStep, textStep } from './scripts.ts';

const NESTING_DEPTH = 3000;

const deeplyNestedArguments = (depth: number): string => `{"value":"x","nested":${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}}`;

const deepCall: FunctionCallItem = {
  type: 'function_call',
  id: 'fc_deep',
  call_id: 'call_deep',
  name: 'Echo',
  arguments: deeplyNestedArguments(NESTING_DEPTH),
  status: 'completed',
};

describe('tool call arguments nested beyond the stack', () => {
  it(`settles on the first claim without executing a call whose arguments nest ${NESTING_DEPTH} deep, naming the nesting`, async () => {
    const env = await makeEnv();
    env.gateway.script.push(outputStep([deepCall]), textStep('Done.'));
    const run = env.enqueue('Echo deeply');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    const settled = env.run(run.id);
    expect(settled.status).not.toBe('QUEUED');
    expect(settled.attempts).toBe(1);
    const notices = env.ofType(run.id, 'notice');
    expect(notices.filter((notice) => notice.code === 'attempt_retried')).toEqual([]);
    expect(notices.map((notice) => notice.message).join('\n')).not.toMatch(/Maximum call stack size exceeded/);
    expect(env.toolbox.executions).toEqual([]);
    const reported = [
      ...env.ofType(run.id, 'tool.completed').map((event) => event.output),
      settled.error?.message ?? '',
    ].join('\n');
    expect(reported).toMatch(/nest|depth/i);
  });
});
