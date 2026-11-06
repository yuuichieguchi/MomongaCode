import { describe, expect, it } from 'vitest';
import type { ResultOutcome } from '@momonga/tools';
import { outcomePayloads } from '../../src/worker/tool-step.ts';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const logRaw = (): string =>
  [
    ...Array.from({ length: 60 }, () => 'warning: unused import'),
    ...Array.from({ length: 400 }, (_unused, index) => `compiled module ${index + 1}`),
    '',
    'the widget count drifted to 9 in src/math.ts:42',
    '',
    ...Array.from({ length: 400 }, (_unused, index) => `linked chunk ${index + 1}`),
  ].join('\n');

const runEcho = async (formatters: ('log' | 'json' | 'grep' | 'identicalOutput')[], task = 'Echo') => {
  const env = await makeEnv({ mode: 'bypassPermissions' });
  env.settings.contextValue = { ...env.settings.contextValue, outputFormatters: formatters };
  env.gateway.script.push(callsStep([{ callId: 'call_f_1', name: 'Echo', args: { value: 'one' } }]), textStep('Echoed.'));
  const worker = env.worker('worker-1');
  const run = env.enqueue(task);
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
    expect(formatted?.output).toContain('the widget count drifted to 9 in src/math.ts:42');
    expect(formatted?.output).toContain('compiled module 200\n');
    expect(formatted?.output.startsWith('warning: unused import [×60]\ncompiled module 1\n')).toBe(true);
  });

  it('passes the terms of the task text to the json formatter', async () => {
    const users = Array.from({ length: 40 }, (_unused, index) => ({ id: index + 1, name: index === 16 ? 'needle-owner' : `user-${index + 1}`, role: 'member' }));
    const raw = JSON.stringify({ users }, null, 2);
    const withTerm = await runEcho(['json'], 'Echo the record of Needle-Owner');
    const withoutTerm = await runEcho(['json'], 'Echo the records');
    const tool = { name: 'WebFetch', kind: 'fetch' } as const;
    const found = withTerm?.formatOutput?.({ output: raw, status: 'completed', tool });
    const absent = withoutTerm?.formatOutput?.({ output: raw, status: 'completed', tool });
    expect(found?.formatter).toBe('json');
    expect(found?.output).toContain('needle-owner');
    expect(absent?.formatter).toBe('json');
    expect(absent?.output).not.toContain('needle-owner');
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
