import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contextFor, countingRunner, makeGitWorld, operationTool, partsOf } from './support.ts';

const worldWithRemote = () => {
  const world = makeGitWorld();
  world.git(world.work, 'remote', 'set-url', 'origin', `file://${world.bare}`);
  world.write('a.txt', 'one\n');
  world.commitAll('first');
  return world;
};

const writtenByAnEarlierBuild = (prepared: Record<string, unknown> | undefined): Record<string, unknown> => {
  const before = prepared?.['before'];
  if (prepared === undefined || typeof before !== 'object' || before === null || !('destinations' in before)) throw new Error('the prepared record holds no destinations');
  const { destinations, ...rest } = before;
  return { ...prepared, before: { ...rest, pushUrls: destinations } };
};

describe('the destinations an operation reaches are recorded under one name for a push and a fetch', () => {
  it.each(['GitPush', 'GitFetch'])('%s records them as destinations, and no longer as pushUrls', async (name) => {
    const world = worldWithRemote();
    if (name === 'GitFetch') world.git(world.work, 'push', '-q', 'origin', 'main');
    const parts = partsOf(operationTool(name, { runArgv: countingRunner().run }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));

    const prepared = await parts.prepare();

    expect(prepared).toMatchObject({ before: { destinations: [`file://${world.bare}`] } });
    expect(prepared?.['before']).not.toHaveProperty('pushUrls');
  });

  it('completes a call whose record an earlier build wrote with the old name', async () => {
    const world = worldWithRemote();
    const parts = partsOf(operationTool('GitPush', { runArgv: countingRunner().run }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));

    const result = await parts.execute(writtenByAnEarlierBuild(await parts.prepare()));

    expect(result.status).toBe('completed');
  });

  it('still compares the destinations of a record with the old name: a change after the approval sends nothing', async () => {
    const world = worldWithRemote();
    const parts = partsOf(operationTool('GitPush', { runArgv: countingRunner().run }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    const prepared = writtenByAnEarlierBuild(await parts.prepare());
    const elsewhere = path.join(world.base, 'elsewhere.git');
    world.git(world.base, 'init', '--bare', '--initial-branch=main', elsewhere);
    world.git(world.work, 'remote', 'set-url', 'origin', `file://${elsewhere}`);

    const result = await parts.execute(prepared);

    expect(result.status).toBe('failed');
    expect(world.git(world.base, 'ls-remote', elsewhere, 'refs/heads/main')).toBe('');
  });
});
