import { describe, expect, it } from 'vitest';
import type { CallOutcome, WorkTreeMark, WorkTreeObserver } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

const COMMAND_SCHEMA = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } as const;

const treeOf = (index: number): string => index.toString(16).padStart(40, '0');

const countingObserver = (): WorkTreeObserver => {
  let made = 0;
  const nextMark = (): WorkTreeMark => {
    made += 1;
    return { tree: treeOf(made), oversized: [], unseen: false };
  };
  return {
    mark: async () => nextMark(),
    changedSince: async () => ({ files: [], mark: nextMark(), oversized: [], complete: true }),
  };
};

const sh = makeTool('Sh', {
  sideEffect: 'exec',
  subjectKind: 'command',
  kind: 'execute',
  inputSchema: COMMAND_SCHEMA,
  subject: (input) => ({ kind: 'command', tool: 'Sh', command: String(input['command']) }),
  execute: async () => ({ status: 'completed', output: 'ran', exitCode: 0 }),
});

const resultOf = (outcome: CallOutcome | undefined) => {
  if (outcome?.kind !== 'result') throw new Error(`expected a result, got ${outcome?.kind}`);
  return outcome.result;
};

describe('the observed call names the trees its observation compared', () => {
  it('carries the tree of the mark and the tree of the closing in the result written into the run event', async () => {
    const harness = makeHarness({ executor: { workTreeObserver: countingObserver() } as never });
    const [outcome] = await harness.executor.runBatch(await harness.input(await toolSetOf(sh), [call('c1', 'Sh', { command: 'make' }, 'allow_once')]));
    expect(resultOf(outcome)).toMatchObject({ observedTrees: { from: treeOf(1), to: treeOf(2) } });
  });
});
