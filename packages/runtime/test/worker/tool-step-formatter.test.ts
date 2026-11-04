import { describe, expect, it } from 'vitest';
import { FAILURE_MARKERS } from '@momonga/context';
import type { ResultOutcome } from '@momonga/tools';
import { outcomePayloads } from '../../src/worker/tool-step.ts';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const logRaw = (): string =>
  [
    ...Array.from({ length: 400 }, (_unused, index) => `compiled module ${index + 1}`),
    '',
    `${FAILURE_MARKERS[0] as string} src/math.test.ts:42 sum_handles_overflow expected 7 got 9`,
    '',
    ...Array.from({ length: 400 }, (_unused, index) => `linked chunk ${index + 1}`),
  ].join('\n');

const runEcho = async (formatters: ('log' | 'json' | 'grep' | 'identicalOutput')[]) => {
  const env = await makeEnv({ mode: 'bypassPermissions' });
  env.settings.contextValue = { ...env.settings.contextValue, outputFormatters: formatters };
  env.gateway.script.push(callsStep([{ callId: 'call_f_1', name: 'Echo', args: { value: 'one' } }]), textStep('Echoed.'));
  const worker = env.worker('worker-1');
  const run = env.enqueue('Echo');
  expect(await env.runOnce(worker)).toBe('yielded');
  expect(env.run(run.id).status).toBe('COMPLETED');
  expect(env.batches).toHaveLength(1);
  return env.batches[0];
};

describe('the batch formatter of the tool step', () => {
  it('passes a formatter that applies the pinned log formatter to an execute tool, and none when the run pinned no formatters', async () => {
    expect((await runEcho([]))?.formatOutput).toBeUndefined();
    const batch = await runEcho(['log']);
    const formatted = batch?.formatOutput?.({ output: logRaw(), status: 'failed', tool: { name: 'Bash', kind: 'execute' } });
    expect(formatted?.formatter).toBe('log');
    expect(formatted?.output).toContain('src/math.test.ts:42 sum_handles_overflow');
    expect(formatted?.output).not.toContain('compiled module 200\n');
  });

  it('passes a formatter that leaves alone what the pin does not enable', async () => {
    const batch = await runEcho(['grep']);
    expect(batch?.formatOutput).toBeDefined();
    expect(batch?.formatOutput?.({ output: logRaw(), status: 'completed', tool: { name: 'Bash', kind: 'execute' } })).toBeUndefined();
  });
});

describe('the tool.completed payload of a formatted result', () => {
  it('records which formatter and version produced the output, beside the raw handle, and none for an unformatted result', () => {
    const plain: ResultOutcome = { callId: 'call_2', kind: 'result', result: { status: 'completed', output: 'plain' } };
    expect(outcomePayloads(plain)[0]).toEqual({ type: 'tool.completed', callId: 'call_2', status: 'completed', output: 'plain' });
    const outcome: ResultOutcome = {
      callId: 'call_1',
      kind: 'result',
      result: { status: 'completed', output: 'formatted view', handle: 'ab'.repeat(32), formatted: { formatter: 'grep', version: 1 } },
    };
    expect(outcomePayloads(outcome)[0]).toEqual({
      type: 'tool.completed',
      callId: 'call_1',
      status: 'completed',
      output: 'formatted view',
      handle: 'ab'.repeat(32),
      formatted: { formatter: 'grep', version: 1 },
    });
  });
});
