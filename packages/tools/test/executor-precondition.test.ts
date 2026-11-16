import { describe, expect, it } from 'vitest';
import type { NeedsApprovalOutcome } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

const writingTool = (events: string[], precondition: () => Promise<void>) =>
  makeTool('Mark', {
    kind: 'edit',
    sideEffect: 'write',
    subjectKind: 'path',
    subject: () => ({ kind: 'path', tool: 'Mark', paths: ['/somewhere/else'], access: 'write' }),
    precondition: async () => {
      events.push('precondition');
      await precondition();
    },
    execute: async () => {
      events.push('execute');
      return { status: 'completed', output: 'written' };
    },
  });

const askedFor = (outcome: unknown): NeedsApprovalOutcome => {
  if (typeof outcome !== 'object' || outcome === null || !('kind' in outcome) || outcome.kind !== 'needs_approval') throw new Error('expected an approval request');
  return outcome as NeedsApprovalOutcome;
};

describe('a precondition is checked after the person allows the call', () => {
  it('is not checked before the approval is asked, and is checked once before the write when allowed', async () => {
    const harness = makeHarness();
    const events: string[] = [];
    const tool = writingTool(events, async () => {});
    const toolSet = await toolSetOf(tool);

    const [asked] = await harness.executor.runBatch(await harness.input(toolSet, [call('c1', 'Mark')], {}));
    expect(askedFor(asked).kind).toBe('needs_approval');
    expect(events).toEqual([]);

    const subjectDigest = askedFor(asked).subjectDigest;
    const [result] = await harness.executor.runBatch(await harness.input(toolSet, [call('c1', 'Mark', {}, { kind: 'allow_once', subjectDigest })], {}));
    expect(result).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(events).toEqual(['precondition', 'execute']);
  });

  it('refuses the allowed call before the write when the precondition fails then', async () => {
    const harness = makeHarness();
    const events: string[] = [];
    const tool = writingTool(events, async () => {
      throw new Error('the file changed');
    });
    const toolSet = await toolSetOf(tool);

    const [asked] = await harness.executor.runBatch(await harness.input(toolSet, [call('c1', 'Mark')], {}));
    const subjectDigest = askedFor(asked).subjectDigest;
    const [result] = await harness.executor.runBatch(await harness.input(toolSet, [call('c1', 'Mark', {}, { kind: 'allow_once', subjectDigest })], {}));

    expect(result).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect(events).toEqual(['precondition']);
  });
});
