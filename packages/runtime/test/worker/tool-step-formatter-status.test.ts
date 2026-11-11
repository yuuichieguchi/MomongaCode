import { describe, expect, it } from 'vitest';
import { formatJson } from '@momonga/context';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const runEcho = async (formatters: ('log' | 'json' | 'grep' | 'identicalOutput')[]) => {
  const env = await makeEnv({ mode: 'bypassPermissions' });
  env.settings.contextValue = { ...env.settings.contextValue, outputFormatters: formatters };
  env.gateway.script.push(callsStep([{ callId: 'call_s_1', name: 'Echo', args: { value: 'one' } }]), textStep('Echoed.'));
  const worker = env.worker('worker-1');
  const run = await env.enqueue('Echo');
  expect(await env.runOnce(worker)).toBe('yielded');
  expect(env.run(run.id).status).toBe('COMPLETED');
  expect(env.batches).toHaveLength(1);
  return env.batches[0];
};

const jsonArray = (): string => JSON.stringify(Array.from({ length: 40 }, (_unused, index) => ({ id: index + 1, name: `user-${index + 1}`, role: 'member' })), null, 2);

describe('the batch formatter of the tool step receives the record status', () => {
  it('the batch formatter receives the record status: a failed call is never reduced by json, a completed one is', async () => {
    const batch = await runEcho(['json']);
    const tool = { name: 'Bash', kind: 'execute' } as const;
    const completed = batch?.formatOutput?.({ output: jsonArray(), status: 'completed', tool });
    expect(completed?.formatter).toBe('json');
    expect(completed?.output).toBe(formatJson(jsonArray(), []));
    expect(batch?.formatOutput?.({ output: jsonArray(), status: 'failed', tool })).toBeUndefined();
  });
});
