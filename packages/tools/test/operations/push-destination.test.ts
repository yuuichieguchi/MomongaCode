import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contextFor, countingRunner, gateFactsFor, makeGitWorld, operationTool, partsOf, subjectFor } from './support.ts';
import { testPaths } from '@momonga/testkit';

const shaIn = (world: ReturnType<typeof makeGitWorld>, bare: string): string => {
  const out = world.git(world.base, 'ls-remote', bare, 'refs/heads/main');
  return out === '' ? 'absent' : (out.split(/\s+/)[0] as string);
};

const worldWithRewrites = (rewrite: (world: ReturnType<typeof makeGitWorld>, elsewhere: string) => void) => {
  const world = makeGitWorld();
  const elsewhere = path.join(world.base, 'elsewhere.git');
  world.git(world.base, 'init', '--bare', '--initial-branch=main', elsewhere);
  world.git(world.work, 'remote', 'set-url', 'origin', `file://${world.bare}`);
  world.write('a.txt', 'one\n');
  const head = world.commitAll('first');
  rewrite(world, elsewhere);
  return { world, elsewhere, head };
};

const REWRITES: ReadonlyArray<readonly [string, (world: ReturnType<typeof makeGitWorld>, elsewhere: string) => void]> = [
  ['remote.origin.pushurl', (world, elsewhere) => world.git(world.work, 'config', 'remote.origin.pushurl', `file://${elsewhere}`)],
  ['url.<base>.pushInsteadOf', (world, elsewhere) => world.git(world.work, 'config', `url.file://${elsewhere}.pushInsteadOf`, `file://${world.bare}`)],
  ['url.<base>.insteadOf', (world, elsewhere) => world.git(world.work, 'config', `url.file://${elsewhere}.insteadOf`, `file://${world.bare}`)],
];

describe.each(REWRITES)('GitPush when %s makes git push somewhere other than the raw remote url', (_name, rewrite) => {
  it('reports what was pushed from the repository git pushed to', async () => {
    const { world, elsewhere, head } = worldWithRewrites(rewrite);
    const tool = operationTool('GitPush', { runArgv: countingRunner().run });
    const parts = partsOf(tool, { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(shaIn(world, elsewhere), 'the repository git really pushed to').toBe(head);
    expect(shaIn(world, world.bare), 'the repository the raw url names').toBe('absent');
    expect(result.status).toBe('completed');
  });

  it('names in its subject the destination git pushes to', async () => {
    const { world, elsewhere } = worldWithRewrites(rewrite);
    const tool = operationTool('GitPush', { runArgv: countingRunner().run });
    const subject = await subjectFor(tool, { remote: 'origin', branch: 'main' }, world);
    expect(JSON.stringify(subject)).toContain(path.basename(elsewhere));
    expect(fs.existsSync(elsewhere)).toBe(true);
  });
});

describe('an insteadOf alias in the raw remote url', () => {
  it('is read by the forge host lookup as a host named after the alias', async () => {
    const { parseRemoteUrl } = await import('../../src/forge/remote.ts');
    expect(parseRemoteUrl('gh:acme/widgets')).toEqual({ host: 'gh', repo: 'acme/widgets' });
  });
});

describe('GitPush with several push urls, or a destination that moves after the approval', () => {
  const twoUrls = () => {
    const world = makeGitWorld();
    const second = path.join(world.base, 'second.git');
    const third = path.join(world.base, 'third.git');
    world.git(world.base, 'init', '--bare', '--initial-branch=main', second);
    world.git(world.base, 'init', '--bare', '--initial-branch=main', third);
    world.git(world.work, 'remote', 'set-url', 'origin', `file://${world.bare}`);
    world.git(world.work, 'config', '--add', 'remote.origin.pushurl', `file://${second}`);
    world.git(world.work, 'config', '--add', 'remote.origin.pushurl', `file://${third}`);
    world.write('a.txt', 'one\n');
    const head = world.commitAll('first');
    return { world, second, third, head };
  };

  it('records every push destination at prepare, observes all of them and pushes to all', async () => {
    const { world, second, third, head } = twoUrls();
    const tool = operationTool('GitPush', { runArgv: countingRunner().run });
    const parts = partsOf(tool, { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    expect(prepared).toMatchObject({ before: { pushUrls: [`file://${second}`, `file://${third}`] } });
    const result = await parts.execute(prepared);
    expect(result.status).toBe('completed');
    expect(shaIn(world, second)).toBe(head);
    expect(shaIn(world, third)).toBe(head);
    expect(shaIn(world, world.bare)).toBe('absent');
  });

  it('names every push destination in the subject and marks that they differ from the fetch url', async () => {
    const { world, second, third } = twoUrls();
    const tool = operationTool('GitPush', { runArgv: countingRunner().run });
    const subject = await subjectFor(tool, { remote: 'origin', branch: 'main' }, world);
    expect(subject).toMatchObject({ destinations: [`file://${second}`, `file://${third}`], destinationsMatchFetch: false });
  });

  it('refuses to push when the destinations changed between prepare and execute', async () => {
    const { world, second, third } = twoUrls();
    const runner = countingRunner();
    const tool = operationTool('GitPush', { runArgv: runner.run });
    const parts = partsOf(tool, { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    world.git(world.work, 'config', '--unset-all', 'remote.origin.pushurl');
    world.git(world.work, 'config', 'remote.origin.pushurl', `file://${second}`);
    runner.calls.length = 0;
    const result = await parts.execute(prepared);
    expect(result.status).toBe('failed');
    expect(result.output).toContain('push destinations changed');
    expect(runner.calls.some((argv) => argv.includes('push'))).toBe(false);
    expect(shaIn(world, second)).toBe('absent');
    expect(shaIn(world, third)).toBe('absent');
  });

  it('refuses to start when the destinations changed between the permission decision and prepare', async () => {
    const { world, second } = twoUrls();
    const runner = countingRunner();
    const tool = operationTool('GitPush', { runArgv: runner.run });
    const input = { remote: 'origin', branch: 'main' };
    const ctx = contextFor(world.work, world.env);
    const decidedOn = await gateFactsFor(tool, input, ctx);
    world.git(world.work, 'config', '--unset-all', 'remote.origin.pushurl');
    world.git(world.work, 'config', 'remote.origin.pushurl', `file://${second}`);
    await expect(tool.prepare?.(input, ctx, decidedOn)).rejects.toThrow('changed between the permission decision and the start');
    expect(runner.calls.some((argv) => argv.includes('push'))).toBe(false);
    expect(shaIn(world, second)).toBe('absent');
  });

  it('refuses a resolution that was aborted, naming the cause', async () => {
    const { world } = twoUrls();
    const tool = operationTool('GitPush', { runArgv: countingRunner().run });
    const aborted = new AbortController();
    aborted.abort();
    await expect(tool.gateFacts?.({ remote: 'origin', branch: 'main' }, { paths: testPaths(), cwd: world.work, workingDirectory: world.work, home: world.home, roots: [world.work] }, { signal: aborted.signal, env: world.env, context: contextFor(world.work, world.env) })).rejects.toThrow('cancelled or ran out of time');
  });
});
