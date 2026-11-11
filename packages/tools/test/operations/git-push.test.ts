import { describe, expect, it } from 'vitest';
import { contextFor, countingRunner, makeGitWorld, operationTool, partsOf, remoteSha, subjectFor } from './support.ts';

const pushedWorld = () => {
  const world = makeGitWorld();
  world.git(world.work, 'remote', 'set-url', 'origin', `file://${world.bare}`);
  world.write('a.txt', 'one\n');
  const first = world.commitAll('first');
  world.git(world.work, 'push', '-q', 'origin', 'main');
  world.write('a.txt', 'two\n');
  const second = world.commitAll('second');
  return { world, first, second };
};

const moveRemoteElsewhere = (world: ReturnType<typeof makeGitWorld>): string => {
  const other = world.clone('other');
  world.git(other, 'commit', '-q', '--allow-empty', '-m', 'someone else');
  world.git(other, 'push', '-q', 'origin', 'main');
  return world.git(other, 'rev-parse', 'HEAD');
};

const PUSH = { remote: 'origin', branch: 'main' };

describe('GitPush to a bare remote over the file protocol', () => {
  it('records the remote ref and the local sha before the effect', async () => {
    const { world, first, second } = pushedWorld();
    const prepared = await partsOf(operationTool('GitPush', { runArgv: countingRunner().run }), PUSH, contextFor(world.work, world.env)).prepare();
    expect(prepared).toMatchObject({ before: { remoteRef: first, localSha: second } });
  });

  it('advances the remote ref to the local sha', async () => {
    const { world, second } = pushedWorld();
    const parts = partsOf(operationTool('GitPush', { runArgv: countingRunner().run }), PUSH, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result.status).toBe('completed');
    expect(remoteSha(world, 'main')).toBe(second);
  });

  it('finds the push applied after a kill between the push and complete, and pushes no second time (crash c3)', async () => {
    const { world, second } = pushedWorld();
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitPush', { runArgv: runner.run }), PUSH, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    await parts.execute(prepared);
    runner.calls.length = 0;
    const reconciled = await parts.reconcile(prepared, Date.now());
    expect(reconciled.outcome).toBe('already_applied');
    expect(reconciled.output).toContain(second);
    expect(runner.calls.some((argv) => argv.includes('push'))).toBe(false);
    expect(remoteSha(world, 'main')).toBe(second);
  });

  it('reports not_applied when the effect started but did not land, because the push is compare-and-set guarded (crash c2)', async () => {
    const { world, first, second } = pushedWorld();
    const parts = partsOf(operationTool('GitPush', { runArgv: countingRunner().run }), PUSH, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    const reconciled = await parts.reconcile(prepared, Date.now());
    expect(reconciled.outcome).toBe('not_applied');
    expect(remoteSha(world, 'main')).toBe(first);
    const redo = await parts.execute(prepared);
    expect(redo.status).toBe('completed');
    expect(remoteSha(world, 'main')).toBe(second);
  });

  it('fails without overwriting when someone else moved the remote between prepare and the effect', async () => {
    const { world } = pushedWorld();
    const parts = partsOf(operationTool('GitPush', { runArgv: countingRunner().run }), PUSH, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    const theirs = moveRemoteElsewhere(world);
    const result = await parts.execute(prepared);
    expect(result.status).toBe('failed');
    expect(remoteSha(world, 'main')).toBe(theirs);
  });

  it('answers unknown after a crash when the remote now holds a third value', async () => {
    const { world } = pushedWorld();
    const parts = partsOf(operationTool('GitPush', { runArgv: countingRunner().run }), PUSH, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    const theirs = moveRemoteElsewhere(world);
    const reconciled = await parts.reconcile(prepared, Date.now());
    expect(reconciled.outcome).toBe('unknown');
    expect(remoteSha(world, 'main')).toBe(theirs);
  });

  it('leases a force push on the observed remote ref, so a ref moved after prepare is not overwritten', async () => {
    const { world } = pushedWorld();
    world.git(world.work, 'commit', '-q', '--amend', '-m', 'second, amended');
    const parts = partsOf(operationTool('GitPush', { runArgv: countingRunner().run }), { ...PUSH, force: true }, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    const theirs = moveRemoteElsewhere(world);
    const result = await parts.execute(prepared);
    expect(result.status).toBe('failed');
    expect(remoteSha(world, 'main')).toBe(theirs);
  });
});

describe('the permission subject of GitPush', () => {
  const subjectOf = (input: Record<string, unknown>, protectedRefs: string[] = []) => {
    const world = makeGitWorld();
    const tool = operationTool('GitPush', { runArgv: countingRunner().run, settings: { protectedRefs } });
    return subjectFor(tool, input, world);
  };

  it('is a repo subject naming the remote and the ref, approved by rule for a plain push', async () => {
    expect(await subjectOf(PUSH)).toMatchObject({ kind: 'repo', tool: 'GitPush', operation: 'GitPush', remote: 'origin', refs: ['main'], approval: 'rule' });
  });

  it.each([
    ['a force push', { ...PUSH, force: true }],
    ['a remote ref delete', { ...PUSH, delete: true }],
  ])('always needs a person for %s', async (_label, input) => {
    expect(await subjectOf(input)).toMatchObject({ kind: 'repo', approval: 'always' });
  });

  it('always needs a person for a push to a ref listed in protectedRefs of the user settings', async () => {
    expect(await subjectOf(PUSH, ['main'])).toMatchObject({ approval: 'always' });
    expect(await subjectOf({ remote: 'origin', branch: 'feature/x' }, ['main'])).toMatchObject({ approval: 'rule' });
  });
});
