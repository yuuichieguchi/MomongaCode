import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { validateToolInput } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { keyFor } from './helpers.ts';
import { makeBuiltins, resultOf } from './builtins/fixtures.ts';
import { contextFor, countingRunner, makeGitWorld, operationTool, partsOf } from './operations/support.ts';

const nested = (depth: number): unknown => {
  let value: unknown = 'leaf';
  for (let level = 0; level < depth; level += 1) value = { inner: value };
  return value;
};

describe('a result text names what was established', () => {
  it('a recovered call whose effect was not applied says that nothing changed', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(keyFor('run-1', 1, 'c1'), 'PENDING', { tool: 'Mark' });
    const tool = makeTool('Mark', {
      kind: 'edit',
      sideEffect: 'write',
      subjectKind: 'none',
      reconcile: async () => ({ outcome: 'not_applied', output: 'reconciled not_applied' }),
    });

    const [outcome] = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Mark')], { recoverOnly: true }));

    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'not_applied', result: { status: 'failed' } });
    const output = outcome?.kind === 'result' ? outcome.result.output : '';
    expect(output).toBe('Mark was cancelled before it changed anything; nothing changed.');
  });

  it('a git command that fails reports its standard output as well as its standard error', async () => {
    const world = makeGitWorld();
    world.write('a.txt', 'one\n');
    world.commitAll('base');
    const parts = partsOf(operationTool('GitCommit', { runArgv: countingRunner().run }), { message: 'Nothing' }, contextFor(world.work, world.env));

    const result = await parts.execute(await parts.prepare());

    expect(result.status).toBe('failed');
    expect(result.output).toContain('nothing to commit');
  });

  it('an absolute glob pattern is refused with the form that works', async () => {
    const tools = await makeBuiltins();
    tools.write('src/a.ts', 'x');

    const result = resultOf(await tools.run('Glob', { pattern: '/src/*.ts' }));

    expect(result.status).toBe('failed');
    expect(result.output).toBe('The pattern /src/*.ts is absolute; use a pattern relative to the search root, and name the root with path.');
  });

  it('arguments nested too deep are named as such', async () => {
    const result = await validateToolInput(makeTool('Edit', { inputSchema: { type: 'object' } }), nested(MAX_JSON_DEPTH + 2));

    expect(result).toEqual({ ok: false, reason: 'invalid', message: `Invalid input for Edit: the arguments nest deeper than ${MAX_JSON_DEPTH} levels` });
  });
});
