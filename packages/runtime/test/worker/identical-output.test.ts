import { describe, expect, it } from 'vitest';
import type { OutputFormatterName } from '@momonga/protocol';
import { defineTool } from '@momonga/tools';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { inputOf, outputTextFor } from './within-turn-support.ts';

const GREP_RAW = [
  "src/app/main.ts:3:import { load } from './load';",
  ...Array.from({ length: 40 }, (_unused, index) => `src/app/main.ts:${10 + index}:  return null;`),
  'test/main.test.ts:5:  return null;',
].join('\n');

const REFERENCE = /^\[identical to the output of call (\S+); stored as ([0-9a-f]{64})\]$/;

const grepTool = defineTool<Record<string, unknown>>({
  name: 'Grep',
  description: 'Search file contents',
  kind: 'search',
  sideEffect: 'read_only',
  subjectKind: 'none',
  inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'], additionalProperties: false },
  timeoutMs: 60_000,
  title: () => 'Grep',
  subject: () => ({ kind: 'none', tool: 'Grep' }),
  execute: async () => ({ status: 'completed', output: GREP_RAW }),
});

const runTwoGreps = async (formatters: OutputFormatterName[]) => {
  const env = await makeEnv({ mode: 'bypassPermissions' });
  env.settings.contextValue = { ...env.settings.contextValue, outputFormatters: formatters };
  env.gateway.script.push(
    callsStep([{ callId: 'call_g_1', name: 'Grep', args: { pattern: 'null' } }]),
    callsStep([{ callId: 'call_g_2', name: 'Grep', args: { pattern: 'null' } }]),
    callsStep([{ callId: 'call_g_3', name: 'Grep', args: { pattern: 'load' } }]),
    textStep('Done.'),
  );
  const run = await env.enqueue('Find the nulls');
  expect(await env.runOnce(env.worker('worker-1', { toolList: () => [grepTool] }))).toBe('yielded');
  expect(env.run(run.id).status).toBe('COMPLETED');
  const requests = env.ofType(run.id, 'model.requested').map((request) => inputOf(request.body as { input?: unknown }));
  expect(requests).toHaveLength(4);
  const idOf = (scripted: string): string => {
    const found = (requests[3] ?? []).find((item) => item.type === 'function_call' && item.id === `fc_${scripted}`);
    if (found?.type !== 'function_call') throw new Error(`missing ${scripted}`);
    return found.call_id;
  };
  return { env, run, requests, g1: idOf('call_g_1'), g2: idOf('call_g_2'), g3: idOf('call_g_3') };
};

describe('identicalOutput in a run', () => {
  it('sends the second byte-identical output as a reference when the pin enables identicalOutput', async () => {
    const { env, run, requests, g1, g2 } = await runTwoGreps(['grep', 'identicalOutput']);
    const first = env.ofType(run.id, 'tool.completed').find((event) => event.callId === g1);
    expect(first?.handle).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.output).not.toBe(GREP_RAW);
    const third = requests[2] ?? [];
    expect(outputTextFor(third, g1)).toBe(first?.output);
    const reference = REFERENCE.exec(outputTextFor(third, g2) ?? '');
    expect(reference?.[1]).toBe(g1);
    expect(reference?.[2]).not.toBe(first?.handle);
  });

  it('sends both outputs in full when the pin does not enable identicalOutput', async () => {
    const { env, run, requests, g1, g2 } = await runTwoGreps(['grep']);
    const formatted = env.ofType(run.id, 'tool.completed').find((event) => event.callId === g1)?.output;
    const third = requests[2] ?? [];
    expect(outputTextFor(third, g1)).toBe(formatted);
    expect(outputTextFor(third, g2)).toBe(formatted);
    expect(env.ofType(run.id, 'context.truncated')).toEqual([]);
  });

  it('records the reference exactly once per referrer, even when the output already carries its raw handle', async () => {
    const { env, run, requests, g2, g3 } = await runTwoGreps(['grep', 'identicalOutput']);
    const references = env.ofType(run.id, 'context.truncated').filter((event) => event.kind === 'reference');
    expect(references.map((event) => event.callId)).toEqual([g2, g3]);
    const rendered = REFERENCE.exec(outputTextFor(requests[2] ?? [], g2) ?? '');
    expect(references[0]?.handle).toBe(rendered?.[2]);
    const evicted = env.fold(run.id).evicted;
    expect(evicted).not.toContain(g2);
    expect(evicted).not.toContain(g3);
  });

  it('renders every later request the same after the reference is recorded', async () => {
    const { requests, g1, g2, g3 } = await runTwoGreps(['grep', 'identicalOutput']);
    const [, , third, fourth] = requests;
    for (const callId of [g1, g2]) {
      expect(outputTextFor(fourth ?? [], callId)).toBe(outputTextFor(third ?? [], callId));
    }
    expect(REFERENCE.exec(outputTextFor(fourth ?? [], g3) ?? '')?.[1]).toBe(g1);
  });
});
