import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { keyFor } from './helpers.ts';

describe('executor and skills', () => {
  it('keeps the skill activation on the result', async () => {
    const harness = makeHarness();
    const skill = { name: 'pdf', content: '<skill_content name="pdf">body</skill_content>' };
    const set = await toolSetOf(makeTool('activate_skill', { execute: async () => ({ status: 'completed', output: skill.content, skill }) }));
    const outcomes = await harness.executor.runBatch(harness.input(set, [call('c1', 'activate_skill')]));
    expect(outcomes).toEqual([
      { callId: 'c1', kind: 'result', result: { status: 'completed', output: skill.content, skill }, idemKey: keyFor('run-1', 1, 'c1') },
    ]);
  });

  it('asks for a read outside the roots and allows it under a read root', async () => {
    const harness = makeHarness();
    const skillDirectory = path.join(harness.layout.outside, 'skills', 'pdf');
    const target = path.join(skillDirectory, 'REFERENCE.md');
    const tool = makeTool('Read', { subject: () => ({ kind: 'path', tool: 'Read', paths: [target], access: 'read' }) });
    const set = await toolSetOf(tool);

    const [asked] = await harness.executor.runBatch(harness.input(set, [call('c1', 'Read')]));
    expect(asked?.kind).toBe('needs_approval');

    const [allowed] = await harness.executor.runBatch(harness.input(set, [call('c2', 'Read')], { readRoots: [skillDirectory] }));
    expect(allowed?.kind).toBe('result');
  });
});
