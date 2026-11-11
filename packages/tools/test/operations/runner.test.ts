import { describe, expect, it } from 'vitest';
import { OPERATION_SPECS, createForgeAccess, loadForgeDescriptors } from '@momonga/tools';
import { startFakeForge } from '@momonga/testkit';
import { contextFor, countingRunner, TEST_FETCH, makeGitWorld, onCleanup, operationTool, partsOf } from './support.ts';

const CREDENTIAL = 'fake-forge-credential-for-tests';

const INPUTS: Record<string, unknown> = {
  GitBranch: { name: 'feature/x', create: true },
  GitStage: { paths: ['a.txt'] },
  GitCommit: { message: 'Add x' },
  GitFetch: { remote: 'origin', branch: 'main' },
  GitUpdate: { remote: 'origin', branch: 'main' },
  GitPush: { remote: 'origin', branch: 'main' },
  PullRequestCreate: { head: 'feature/x', base: 'main', title: 'Add x', body: 'Adds x', headSha: 'a'.repeat(40) },
  PullRequestMerge: { number: 1, headSha: 'a'.repeat(40) },
  PullRequestComment: { number: 1, body: 'Thanks' },
};

const STORED_PREPARED = { before: { head: 'h', indexTree: 't', unstaged: 'a.txt', trackingRef: 'o', behind: '1', remoteRef: 'r', localSha: 'l', branch: 'main', existing: { count: '0' }, pr: { merged: 'false' }, markerCount: '0' }, observedAt: 1_000 };

const effectful = OPERATION_SPECS.filter((spec) => spec.sideEffect !== 'read_only').map((spec) => spec.name);

describe('the generic runner, for any operation', () => {
  it('covers every operation that changes state with an input fixture', () => {
    expect(effectful.sort()).toEqual(Object.keys(INPUTS).sort());
  });

  it.each(Object.keys(INPUTS))('reconciles %s to not_applied without any probe when the effect never started (crash c1)', async (name) => {
    const world = makeGitWorld();
    const forge = await startFakeForge('hub', CREDENTIAL);
    onCleanup(() => forge.close());
    world.git(world.work, 'remote', 'set-url', 'origin', `${forge.origin}/acme/widgets.git`);
    const runner = countingRunner();
    const access = createForgeAccess({
      descriptors: loadForgeDescriptors(),
      instances: [{ id: 'local', descriptor: 'github', host: forge.host, apiBaseUrl: forge.origin, credential: { env: 'FAKE_FORGE_TOKEN' } }],
      fetch: TEST_FETCH,
    readCredential: async () => CREDENTIAL,
    });
    const tool = operationTool(name, { runArgv: runner.run, forge: access });
    const result = await partsOf(tool, INPUTS[name], contextFor(world.work, world.env)).reconcile(STORED_PREPARED, undefined);
    expect(result.outcome).toBe('not_applied');
    expect(runner.calls).toEqual([]);
    expect(forge.requests).toEqual([]);
  });

  it.each(Object.keys(INPUTS))('declares %s as a tool with prepare and reconcile, so the executor records the observation before the effect', (name) => {
    const tool = operationTool(name, { runArgv: countingRunner().run });
    expect(typeof tool.prepare).toBe('function');
    expect(typeof tool.reconcile).toBe('function');
    expect(tool.sideEffect).not.toBe('read_only');
  });

  it('declares PullRequestStatus as a read-only tool without reconcile', () => {
    const tool = operationTool('PullRequestStatus', { runArgv: countingRunner().run });
    expect(tool.sideEffect).toBe('read_only');
    expect(tool.reconcile).toBeUndefined();
  });
});
