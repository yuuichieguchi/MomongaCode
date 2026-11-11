import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contextFor, countingRunner, makeGitWorld, operationTool, partsOf } from './support.ts';

const commitCount = (world: ReturnType<typeof makeGitWorld>): number => Number(world.git(world.work, 'rev-list', '--count', 'HEAD'));

const stagedWorld = () => {
  const world = makeGitWorld();
  world.write('a.txt', 'one\n');
  const base = world.commitAll('base');
  world.write('a.txt', 'two\n');
  world.git(world.work, 'add', 'a.txt');
  const indexTree = world.git(world.work, 'write-tree');
  return { world, base, indexTree };
};

describe('GitCommit', () => {
  it('records the head and the index tree before the effect', async () => {
    const { world, base, indexTree } = stagedWorld();
    const tool = operationTool('GitCommit', { runArgv: countingRunner().run });
    const prepared = await partsOf(tool, { message: 'Add two' }, contextFor(world.work, world.env)).prepare();
    expect(prepared).toMatchObject({ before: { head: base, indexTree } });
    expect(typeof prepared?.['observedAt']).toBe('number');
  });

  it('commits the index once and reports success from the observed head', async () => {
    const { world, base, indexTree } = stagedWorld();
    const parts = partsOf(operationTool('GitCommit', { runArgv: countingRunner().run }), { message: 'Add two' }, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result.status).toBe('completed');
    expect(world.git(world.work, 'rev-parse', 'HEAD^')).toBe(base);
    expect(world.git(world.work, 'rev-parse', 'HEAD^{tree}')).toBe(indexTree);
    expect(world.git(world.work, 'log', '-1', '--format=%s')).toBe('Add two');
    expect(result.output).toContain(world.git(world.work, 'rev-parse', 'HEAD'));
  });

  it('makes the first commit of a repository that has none, and answers not applied for an interrupted first commit that did not land', async () => {
    const world = makeGitWorld();
    world.write('a.txt', 'one\n');
    world.git(world.work, 'add', 'a.txt');
    const parts = partsOf(operationTool('GitCommit', { runArgv: countingRunner().run }), { message: 'First' }, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    expect((await parts.reconcile(prepared, Date.now())).outcome).toBe('not_applied');
    const result = await parts.execute(prepared);
    expect(result).toMatchObject({ status: 'completed', effect: { outcome: 'applied' } });
    expect(commitCount(world)).toBe(1);
    expect((await parts.reconcile(prepared, Date.now())).outcome).toBe('already_applied');
  });

  it('finds the commit applied after a kill between the commit and complete, and does not commit again (crash c2/c3)', async () => {
    const { world } = stagedWorld();
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitCommit', { runArgv: runner.run }), { message: 'Add two' }, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    await parts.execute(prepared);
    const head = world.git(world.work, 'rev-parse', 'HEAD');
    const before = commitCount(world);
    runner.calls.length = 0;
    const reconciled = await parts.reconcile(prepared, Date.now());
    expect(reconciled.outcome).toBe('already_applied');
    expect(reconciled.output).toContain(head);
    expect(commitCount(world)).toBe(before);
    expect(world.git(world.work, 'rev-parse', 'HEAD')).toBe(head);
    expect(runner.calls.some((argv) => argv.includes('commit'))).toBe(false);
  });

  it('answers unknown, and never commits a second time, when a hook changed the tree (N5)', async () => {
    const { world, base } = stagedWorld();
    const hook = path.join(world.work, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho hooked >> a.txt\ngit add a.txt\n', { mode: 0o755 });
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitCommit', { runArgv: runner.run }), { message: 'Add two' }, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    const result = await parts.execute(prepared);
    expect(result.status).toBe('failed');
    expect(world.git(world.work, 'rev-parse', 'HEAD^')).toBe(base);
    const count = commitCount(world);
    const reconciled = await parts.reconcile(prepared, Date.now());
    expect(reconciled.outcome).toBe('unknown');
    expect(commitCount(world)).toBe(count);
  });
});

describe('GitBranch', () => {
  it('creates and switches to the branch, and observes it after the effect', async () => {
    const world = makeGitWorld();
    world.write('a.txt', 'one\n');
    world.commitAll('base');
    const parts = partsOf(operationTool('GitBranch', { runArgv: countingRunner().run }), { name: 'feature/x', create: true }, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result.status).toBe('completed');
    expect(world.git(world.work, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/x');
  });

  it('finds the switch already applied after a crash and does not run git switch again', async () => {
    const world = makeGitWorld();
    world.write('a.txt', 'one\n');
    world.commitAll('base');
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitBranch', { runArgv: runner.run }), { name: 'feature/x', create: true }, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    world.git(world.work, 'switch', '-q', '-c', 'feature/x');
    runner.calls.length = 0;
    const reconciled = await parts.reconcile(prepared, Date.now());
    expect(reconciled.outcome).toBe('already_applied');
    expect(runner.calls.some((argv) => argv.includes('switch') || argv.includes('checkout'))).toBe(false);
  });
});
