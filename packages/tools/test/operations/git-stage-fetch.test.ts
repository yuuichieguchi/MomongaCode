import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contextFor, countingRunner, makeGitWorld, operationTool, partsOf, settle } from './support.ts';
import type { GitWorld } from './support.ts';
import { testPaths } from '@momonga/testkit';

const baseWorld = (): GitWorld => {
  const world = makeGitWorld();
  world.write('a.txt', 'one\n');
  world.write('b.txt', 'one\n');
  world.commitAll('base');
  return world;
};

const staged = (world: GitWorld): string[] =>
  world
    .git(world.work, 'diff', '--cached', '--name-only')
    .split('\n')
    .filter((line) => line !== '');

const pushedWorld = (): GitWorld => {
  const world = baseWorld();
  world.git(world.work, 'push', '-q', 'origin', 'main');
  return world;
};

const advanceRemote = (world: GitWorld): string => {
  const other = world.clone('other');
  fs.writeFileSync(path.join(other, 'c.txt'), 'remote\n');
  world.git(other, 'add', 'c.txt');
  world.git(other, 'commit', '-q', '-m', 'remote change');
  world.git(other, 'push', '-q', 'origin', 'main');
  return world.git(other, 'rev-parse', 'HEAD');
};

describe('GitStage', () => {
  it('stages exactly the listed paths: a changed file, a new file and a deleted file, and nothing else', async () => {
    const world = baseWorld();
    world.write('a.txt', 'two\n');
    world.write('b.txt', 'two\n');
    world.write('new/n.txt', 'new\n');
    world.write('gone.txt', 'gone\n');
    world.commitAll('with gone');
    world.write('a.txt', 'three\n');
    world.write('b.txt', 'three\n');
    world.write('new/m.txt', 'new\n');
    fs.rmSync(path.join(world.work, 'gone.txt'));
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitStage', { runArgv: runner.run }), { paths: ['a.txt', 'new/m.txt', 'gone.txt'] }, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result).toMatchObject({ status: 'completed', effect: { operation: 'GitStage', outcome: 'applied' } });
    expect(staged(world).sort()).toEqual(['a.txt', 'gone.txt', 'new/m.txt']);
    expect(result.output).toContain(world.git(world.work, 'write-tree'));
  });

  it('reads a path literally, so pathspec magic cannot stage more than was named', async () => {
    const world = baseWorld();
    world.write('a.txt', 'two\n');
    world.write('b.txt', 'two\n');
    const parts = partsOf(operationTool('GitStage', { runArgv: countingRunner().run }), { paths: [':(top)'] }, contextFor(world.work, world.env));
    await settle(async () => parts.execute(await parts.prepare()));
    expect(staged(world)).toEqual([]);
  });

  it('completes as already applied, and runs no git add, when nothing under the paths is unstaged', async () => {
    const world = baseWorld();
    world.write('a.txt', 'two\n');
    world.git(world.work, 'add', 'a.txt');
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitStage', { runArgv: runner.run }), { paths: ['a.txt'] }, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result).toMatchObject({ status: 'completed', effect: { outcome: 'already_applied' } });
    expect(runner.calls.some((argv) => argv.includes('add'))).toBe(false);
  });

  it('after a kill inside the effect finds the staging applied and does not stage again (crash c2)', async () => {
    const world = baseWorld();
    world.write('a.txt', 'two\n');
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitStage', { runArgv: runner.run }), { paths: ['a.txt'] }, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    world.git(world.work, 'add', 'a.txt');
    runner.calls.length = 0;
    const reconciled = await parts.reconcile(prepared, Date.now());
    expect(reconciled).toMatchObject({ outcome: 'already_applied', effect: { operation: 'GitStage', outcome: 'already_applied' } });
    expect(runner.calls.some((argv) => argv.includes('add'))).toBe(false);
  });

  it('after a kill before the effect answers not applied, so the staging is redone', async () => {
    const world = baseWorld();
    world.write('a.txt', 'two\n');
    const parts = partsOf(operationTool('GitStage', { runArgv: countingRunner().run }), { paths: ['a.txt'] }, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    expect((await parts.reconcile(prepared, Date.now())).outcome).toBe('not_applied');
    expect(staged(world)).toEqual([]);
  });
});

describe('GitFetch', () => {
  it('brings the remote-tracking branch to the commit the remote has, and changes neither the head nor the working tree', async () => {
    const world = pushedWorld();
    const head = world.git(world.work, 'rev-parse', 'HEAD');
    const remoteHead = advanceRemote(world);
    const parts = partsOf(operationTool('GitFetch', { runArgv: countingRunner().run }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result).toMatchObject({ status: 'completed', effect: { operation: 'GitFetch', target: 'main', outcome: 'applied' } });
    expect(world.git(world.work, 'rev-parse', 'refs/remotes/origin/main')).toBe(remoteHead);
    expect(world.git(world.work, 'rev-parse', 'HEAD')).toBe(head);
    expect(result.output).toContain(remoteHead);
  });

  it('completes as already applied with no fetch when the remote-tracking branch is current', async () => {
    const world = pushedWorld();
    world.git(world.work, 'fetch', '-q', 'origin');
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitFetch', { runArgv: runner.run }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result).toMatchObject({ status: 'completed', effect: { outcome: 'already_applied' } });
    expect(runner.calls.some((argv) => argv.includes('fetch'))).toBe(false);
  });

  it('fails for a branch the remote does not have', async () => {
    const world = pushedWorld();
    const parts = partsOf(operationTool('GitFetch', { runArgv: countingRunner().run }), { remote: 'origin', branch: 'absent' }, contextFor(world.work, world.env));
    const result = await settle(async () => parts.execute(await parts.prepare()));
    expect(result.status).toBe('failed');
    expect(world.gitStatus(world.work, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/absent')).not.toBe(0);
  });

  it('after a kill inside the fetch finds it applied from the refs, and unchanged when it did not land', async () => {
    const world = pushedWorld();
    advanceRemote(world);
    const parts = partsOf(operationTool('GitFetch', { runArgv: countingRunner().run }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    expect((await parts.reconcile(prepared, Date.now())).outcome).toBe('not_applied');
    world.git(world.work, 'fetch', '-q', 'origin');
    expect(await parts.reconcile(prepared, Date.now())).toMatchObject({ outcome: 'already_applied', effect: { operation: 'GitFetch', outcome: 'already_applied' } });
  });

  it('decides its permission on the place it fetches from, not on the push destinations', async () => {
    const world = pushedWorld();
    world.git(world.work, 'remote', 'set-url', '--push', 'origin', path.join(world.base, 'elsewhere.git'));
    const tool = operationTool('GitFetch', { runArgv: countingRunner().run });
    const ctx = contextFor(world.work, world.env);
    const facts = await tool.gateFacts?.({ remote: 'origin', branch: 'main' }, ctx, { signal: ctx.signal, env: ctx.env });
    const subject = tool.subject({ remote: 'origin', branch: 'main' }, { paths: testPaths(), cwd: world.work, workingDirectory: world.work, home: world.home, roots: [world.work] }, facts);
    expect(subject).toMatchObject({ kind: 'repo', operation: 'GitFetch', remote: 'origin', refs: ['main'], destinations: [world.bare], destinationsMatchFetch: true });
  });
});

describe('GitUpdate', () => {
  it('fast-forwards the checked-out branch to the fetched remote branch', async () => {
    const world = pushedWorld();
    const remoteHead = advanceRemote(world);
    world.git(world.work, 'fetch', '-q', 'origin');
    const parts = partsOf(operationTool('GitUpdate', { runArgv: countingRunner().run }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result).toMatchObject({ status: 'completed', effect: { operation: 'GitUpdate', outcome: 'applied' } });
    expect(world.git(world.work, 'rev-parse', 'HEAD')).toBe(remoteHead);
  });

  it('is already applied when the branch contains the fetched commits, even with local commits on top', async () => {
    const world = pushedWorld();
    world.git(world.work, 'fetch', '-q', 'origin');
    world.write('a.txt', 'local\n');
    world.commitAll('local');
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitUpdate', { runArgv: runner.run }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    expect(await parts.execute(await parts.prepare())).toMatchObject({ status: 'completed', effect: { outcome: 'already_applied' } });
    expect(runner.calls.some((argv) => argv.includes('merge'))).toBe(false);
  });

  it('fails and leaves the head where it was when the branches have diverged', async () => {
    const world = pushedWorld();
    advanceRemote(world);
    world.git(world.work, 'fetch', '-q', 'origin');
    world.write('a.txt', 'local\n');
    const local = world.commitAll('local');
    const parts = partsOf(operationTool('GitUpdate', { runArgv: countingRunner().run }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result).toMatchObject({ status: 'failed', effect: { outcome: 'failed' } });
    expect(world.git(world.work, 'rev-parse', 'HEAD')).toBe(local);
    expect(world.git(world.work, 'rev-list', '--count', '--merges', 'HEAD')).toBe('0');
  });
});

describe('GitBranch', () => {
  it('reports the observed effect of a reconcile whose state matches neither side as unknown', async () => {
    const world = baseWorld();
    const parts = partsOf(operationTool('GitBranch', { runArgv: countingRunner().run }), { name: 'feature/x', create: true }, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    world.git(world.work, 'switch', '-q', '-c', 'elsewhere');
    expect(await parts.reconcile(prepared, Date.now())).toMatchObject({ outcome: 'unknown', effect: { operation: 'GitBranch', target: 'feature/x', outcome: 'unknown' } });
  });
});
