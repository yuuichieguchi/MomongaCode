import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ForgeAccess } from '@momonga/tools';
import { OPERATION_SPECS } from '@momonga/tools';
import { contextFor, countingRunner, gateFactsFor, makeGitWorld, operationTool, partsOf, settle } from './support.ts';
import type { CallContext, GitWorld } from './support.ts';

const sessionIn = (world: GitWorld, cwd: string): CallContext => ({ ...contextFor(cwd, world.env), workingDirectory: world.work, session: { cwd, workingDirectory: world.work, readLedger: new Map() } }) as CallContext;

const nestedWorld = () => {
  const world = makeGitWorld();
  world.git(world.work, 'remote', 'set-url', 'origin', `file://${world.bare}`);
  world.write('a.txt', 'outer\n');
  world.commitAll('outer');
  const nested = path.join(world.work, 'sub');
  const nestedBare = path.join(world.base, 'nested.git');
  world.git(world.base, 'init', '--bare', '--initial-branch=main', nestedBare);
  world.git(world.base, 'init', '--initial-branch=main', nested);
  world.git(nested, 'remote', 'add', 'origin', `file://${nestedBare}`);
  fs.writeFileSync(path.join(nested, 'b.txt'), 'nested\n');
  world.git(nested, 'add', '-A');
  world.git(nested, 'commit', '-q', '-m', 'nested');
  return { world, nested, nestedBare, nestedHead: world.git(nested, 'rev-parse', 'HEAD') };
};

const PUSH = { remote: 'origin', branch: 'main' };

describe('the repository of an operation is the one that contains the working directory of the session', () => {
  it('names the remote of a nested repository in the approval and pushes to that repository, not to the one around it', async () => {
    const { world, nested, nestedBare, nestedHead } = nestedWorld();
    const tool = operationTool('GitPush', { runArgv: countingRunner().run });
    const ctx = sessionIn(world, nested);
    const facts = await gateFactsFor(tool, PUSH, ctx);
    expect(facts).toMatchObject({ repoRoot: nested, pushUrls: [`file://${nestedBare}`] });
    expect(tool.subject(PUSH, ctx, facts)).toMatchObject({ kind: 'repo', destinations: [`file://${nestedBare}`] });
    const parts = partsOf(tool, PUSH, ctx);
    const result = await parts.execute(await parts.prepare(facts));
    expect(result.status).toBe('completed');
    expect(world.git(world.base, 'ls-remote', nestedBare, 'refs/heads/main').split(/\s+/)[0]).toBe(nestedHead);
    expect(world.git(world.base, 'ls-remote', world.bare)).toBe('');
  });

  it('runs every probe and the effect at the top of the repository when the session is in a folder below it', async () => {
    const world = makeGitWorld();
    world.write('pkg/a.txt', 'one\n');
    world.commitAll('base');
    world.write('pkg/a.txt', 'two\n');
    world.git(world.work, 'add', '-A');
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitCommit', { runArgv: runner.run }), { message: 'Add two' }, sessionIn(world, path.join(world.work, 'pkg')));
    const prepared = await parts.prepare();
    expect(prepared).toMatchObject({ repoRoot: world.work });
    const result = await parts.execute(prepared);
    expect(result.status).toBe('completed');
    await parts.reconcile(prepared, Date.now());
    expect(runner.calls.some((argv) => argv.includes('commit'))).toBe(true);
    expect(new Set(runner.directories)).toEqual(new Set([world.work]));
  });

  it('keeps the repository it was approved for when the session moves before the interrupted call is reconciled', async () => {
    const { world, nested } = nestedWorld();
    world.write('a.txt', 'changed\n');
    world.git(world.work, 'add', '-A');
    const runner = countingRunner();
    const tool = operationTool('GitCommit', { runArgv: runner.run });
    const prepared = await partsOf(tool, { message: 'Outer' }, sessionIn(world, world.work)).prepare();
    runner.directories.length = 0;
    const reconciled = await partsOf(tool, { message: 'Outer' }, sessionIn(world, nested)).reconcile(prepared, Date.now());
    expect(reconciled.outcome).toBe('not_applied');
    expect(new Set(runner.directories)).toEqual(new Set([world.work]));
  });

  it('refuses an operation whose working directory is in no repository, with the reason', async () => {
    const world = makeGitWorld();
    const outside = path.join(world.base, 'plain');
    fs.mkdirSync(outside);
    const tool = operationTool('GitCommit', { runArgv: countingRunner().run });
    const parts = partsOf(tool, { message: 'x' }, sessionIn(world, outside));
    expect(await settle(async () => parts.execute(await parts.prepare()))).toMatchObject({ status: 'threw', output: expect.stringContaining('is not inside a git repository') });
  });
});

describe('the forge of a pull request operation is the remote its input names', () => {
  const recordingForge = () => {
    const requested: string[] = [];
    const forge = {
      request: async (call: { remoteUrl: string }) => {
        requested.push(call.remoteUrl);
        return { status: 'success', fields: { state: 'open', merged: 'false', headSha: 'a'.repeat(40), url: 'https://forge.example/pr/7' }, items: [] };
      },
      gitCredential: async () => undefined,
    } as unknown as ForgeAccess;
    return { forge, requested };
  };

  const twoRemotes = (): GitWorld => {
    const world = makeGitWorld();
    world.git(world.work, 'remote', 'set-url', 'origin', 'https://forge.example/me/widgets.git');
    world.git(world.work, 'remote', 'add', 'upstream', 'https://forge.example/acme/widgets.git');
    return world;
  };

  it('asks the forge of upstream when the input says upstream, and names that repository in the approval', async () => {
    const world = twoRemotes();
    const { forge, requested } = recordingForge();
    const tool = operationTool('PullRequestMerge', { runArgv: countingRunner().run, forge });
    const input = { number: 7, headSha: 'a'.repeat(40), remote: 'upstream' };
    const ctx = contextFor(world.work, world.env);
    const facts = await gateFactsFor(tool, input, ctx);
    expect(tool.subject(input, ctx, facts)).toMatchObject({ kind: 'forge', host: 'forge.example', repo: 'acme/widgets' });
    await partsOf(tool, input, ctx).prepare(facts);
    expect(requested).toEqual(['https://forge.example/acme/widgets.git']);
  });

  it('asks the forge of origin when the input names no remote', async () => {
    const world = twoRemotes();
    const { forge, requested } = recordingForge();
    const parts = partsOf(operationTool('PullRequestStatus', { runArgv: countingRunner().run, forge }), { number: 7 }, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result.status).toBe('completed');
    expect(requested).toEqual(['https://forge.example/me/widgets.git']);
  });

  it('reads the pull request of upstream for PullRequestStatus with remote upstream', async () => {
    const world = twoRemotes();
    const { forge, requested } = recordingForge();
    const parts = partsOf(operationTool('PullRequestStatus', { runArgv: countingRunner().run, forge }), { number: 7, remote: 'upstream' }, contextFor(world.work, world.env));
    await parts.execute(await parts.prepare());
    expect(requested).toEqual(['https://forge.example/acme/widgets.git']);
  });

  it('every operation that asks a forge takes the remote as an optional input', () => {
    const asksForge = OPERATION_SPECS.filter((spec) => spec.subject.kind === 'forge' || spec.observe.some((probe) => 'forge' in probe.via) || (spec.effect !== undefined && 'forge' in spec.effect));
    expect(asksForge.map((spec) => spec.name).sort()).toEqual(['PullRequestComment', 'PullRequestCreate', 'PullRequestMerge', 'PullRequestStatus']);
    for (const spec of asksForge) {
      const input = spec.input as { properties: Record<string, unknown>; required: string[] };
      expect(input.properties['remote']).toMatchObject({ type: 'string' });
      expect(input.required).not.toContain('remote');
    }
  });
});
