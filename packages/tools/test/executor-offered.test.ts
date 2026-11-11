import { describe, expect, it } from 'vitest';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

const OFFER = { tools: ['Read'], catalog: ['Grep'] } as const;

const failedOutputOf = async (name: string, offered: { tools: readonly string[]; catalog: readonly string[] } | 'none' = OFFER): Promise<string> => {
  const harness = makeHarness();
  const set = await toolSetOf(makeTool('Read'), makeTool('Grep'), makeTool('Write', { kind: 'edit', sideEffect: 'write', subjectKind: 'none' }));
  const [outcome] = await harness.executor.runBatch(await harness.input(set, [call('c1', name)], offered === 'none' ? {} : { offered }));
  expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'failed' } });
  expect(harness.started).toEqual([]);
  return (outcome as { result: { output: string } }).result.output;
};

const NAME = '<name>';

describe('a call to a tool the request did not offer, by one rule', () => {
  it('answers an unknown name with the offered tools only, never a deferred or hidden one', async () => {
    const output = await failedOutputOf('Raed');
    expect(output).toContain('Raed');
    expect(output).toMatch(/Available tools: Read$/);
    expect(output).not.toContain('Grep');
    expect(output).not.toContain('Write');
  });

  it('answers a known tool that was not offered with the same text as an unknown name', async () => {
    const unknown = await failedOutputOf('Raed');
    const hidden = await failedOutputOf('Write');
    expect(hidden).toMatch(/Available tools: Read$/);
    expect(hidden.replaceAll('Write', NAME)).toBe(unknown.replaceAll('Raed', NAME));
  });

  it('tells the model to load a deferred tool from the catalog before calling it', async () => {
    expect(await failedOutputOf('Grep')).toBe('Tool "Grep" is not loaded: load it with LoadTools first');
  });

  it('lists every tool of the snapshot for an unknown name when no offer is recorded', async () => {
    expect(await failedOutputOf('Nope', 'none')).toBe('Unknown tool "Nope". Available tools: Grep, Read, Write');
  });
});