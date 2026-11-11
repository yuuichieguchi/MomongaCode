import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PolicyHostFilesystem } from '@momonga/policy';
import { fakePolicyFilesystem, hostFilesystemOf, waitFor } from '@momonga/testkit';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

const neverAnswers = <T>(): Promise<T> => new Promise<T>(() => undefined);

const stalledFilesystem = (asked: string[]): PolicyHostFilesystem => {
  const stall =
    (port: string) =>
    <T>(): Promise<T> => {
      asked.push(port);
      return neverAnswers<T>();
    };
  return {
    ...hostFilesystemOf(fakePolicyFilesystem()),
    canonicalise: stall('canonicalise'),
    volumeProbe: stall('volumeProbe'),
    locate: stall('locate'),
    resolveProgram: stall('resolveProgram'),
    readEntry: stall('readEntry'),
    readNoFollow: stall('readNoFollow'),
    readHead: stall('readHead'),
    isSearchable: stall('isSearchable'),
    gitlinks: stall('gitlinks'),
    configPrograms: stall('configPrograms'),
  };
};

const TOOLS = [
  { name: 'PathRead', kind: 'read', sideEffect: 'read_only', access: 'read' },
  { name: 'PathWrite', kind: 'edit', sideEffect: 'write', access: 'write' },
] as const;

describe('executor with a file system that never answers', () => {
  it.each(TOOLS)('$name: the call is reported to the model as cancelled when the signal of the batch fires, and nothing runs', async ({ name, kind, sideEffect, access }) => {
    const asked: string[] = [];
    const harness = makeHarness({ executor: { fs: stalledFilesystem(asked) } });
    const target = path.join(harness.layout.project, 'f.txt');
    const runs: string[] = [];
    const tool = makeTool(name, {
      kind,
      sideEffect,
      subjectKind: 'path',
      subject: () => ({ kind: 'path', tool: name, paths: [target], access }),
      execute: async () => {
        runs.push(target);
        return { status: 'completed', output: 'touched' };
      },
    });
    const controller = new AbortController();
    const settled: unknown[] = [];
    const running = harness.executor
      .runBatch(await harness.input(await toolSetOf(tool), [call('c1', name, {}, 'allow_once')], { mode: 'manual', signal: controller.signal }))
      .then(
        (outcomes) => settled.push({ outcomes }),
        (error: unknown) => settled.push({ error }),
      );
    await waitFor(() => asked.length > 0 || settled.length > 0, { description: 'the stalled file system to be asked or the batch to end' });
    expect(asked.length).toBeGreaterThan(0);
    expect(settled).toEqual([]);
    controller.abort(new Error('the run was stopped'));
    await running;
    expect(settled).toEqual([{ outcomes: [{ callId: 'c1', kind: 'result', result: { status: 'failed', output: `${name} was cancelled` } }] }]);
    expect(runs).toEqual([]);
    expect(harness.idempotency.records.size).toBe(0);
  });
});
