import { describe, expect, it } from 'vitest';
import { createForgeAccess, loadForgeDescriptors, parseForgeDescriptor } from '@momonga/tools';
import type { ForgeAccess, ForgeDescriptor, OperationSettings } from '@momonga/tools';
import { LAB_DESCRIPTOR, startFakeForge } from '@momonga/testkit';
import type { FakeForge, ForgeShape } from '@momonga/testkit';
import { contextFor, countingRunner, TEST_FETCH, makeGitWorld, onCleanup, operationTool, partsOf, settle, subjectFor } from './support.ts';

const CREDENTIAL = 'fake-forge-credential-for-tests';
const HEAD_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

const descriptorFor = (shape: ForgeShape): ForgeDescriptor => {
  if (shape === 'lab') return parseForgeDescriptor(LAB_DESCRIPTOR);
  const shipped = loadForgeDescriptors().find((descriptor) => descriptor.id === 'github');
  if (shipped === undefined) throw new Error('no shipped descriptor with id github');
  return shipped;
};

type Setup = { forge: FakeForge; world: ReturnType<typeof makeGitWorld>; credentialReads: string[]; tool(name: string): ReturnType<typeof operationTool> };

const setup = async (shape: ForgeShape, host?: string): Promise<Setup> => {
  const forge = await startFakeForge(shape, CREDENTIAL);
  onCleanup(() => forge.close());
  forge.branchSha.set('feature/x', HEAD_SHA);
  const world = makeGitWorld();
  world.git(world.work, 'remote', 'set-url', 'origin', `${forge.origin}/acme/widgets.git`);
  const descriptor = descriptorFor(shape);
  const credentialReads: string[] = [];
  const access = createForgeAccess({
    descriptors: [descriptor],
    instances: [{ id: 'local', descriptor: descriptor.id, host: host ?? forge.host, apiBaseUrl: forge.origin, credential: { env: 'FAKE_FORGE_TOKEN' } }],
    fetch: TEST_FETCH,
    readCredential: async (reference) => {
      credentialReads.push(JSON.stringify(reference));
      return CREDENTIAL;
    },
  });
  const runner = countingRunner();
  return { forge, world, credentialReads, tool: (name) => operationTool(name, { runArgv: runner.run, forge: access }) };
};

const CREATE = { head: 'feature/x', base: 'main', title: 'Add x', body: 'Adds x', headSha: HEAD_SHA };

describe('the permission subject of PullRequestMerge (OD-6)', () => {
  const subjectWith = async (settings: OperationSettings) => {
    const { world } = await setup('hub');
    const tool = operationTool('PullRequestMerge', { runArgv: countingRunner().run, settings });
    return subjectFor(tool, { number: 7, headSha: HEAD_SHA }, world);
  };

  it('is a forge subject that carries the pull request and the approved head sha, and always needs a person by default', async () => {
    expect(await subjectWith({})).toMatchObject({ kind: 'forge', tool: 'PullRequestMerge', operation: 'PullRequestMerge', pr: 7, headSha: HEAD_SHA, approval: 'always' });
  });

  it('takes the class rule only from the operation settings the user gave', async () => {
    expect(await subjectWith({ approval: { PullRequestMerge: 'rule' } })).toMatchObject({ approval: 'rule' });
  });
});

describe('the forge the permission subject names is the forge the request goes to', () => {
  it('uses one resolution of the remote, so url rewriting cannot send the request to another host', async () => {
    const { forge, world } = await setup('hub');
    world.git(world.work, 'config', 'url.http://elsewhere.invalid:9/.insteadOf', `${forge.origin}/`);
    const requested: string[] = [];
    const recording = { request: async (call: { remoteUrl: string }) => { requested.push(call.remoteUrl); throw new Error('stop'); } } as unknown as ForgeAccess;
    const tool = operationTool('PullRequestCreate', { runArgv: countingRunner().run, forge: recording });
    const subject = await subjectFor(tool, CREATE, world);
    const parts = partsOf(tool, CREATE, contextFor(world.work, world.env));
    await settle(async () => parts.execute(await parts.prepare()));
    expect(requested.length).toBeGreaterThan(0);
    for (const url of requested) expect(new URL(url).host).toBe((subject as { host: string }).host);
  });
});

describe.each(['hub', 'lab'] as const)('pull request operations against the %s forge shape', (shape) => {
  describe('PullRequestCreate', () => {
    it('creates one pull request and returns its URL', async () => {
      const { forge, world, tool } = await setup(shape);
      const parts = partsOf(tool('PullRequestCreate'), CREATE, contextFor(world.work, world.env));
      const result = await parts.execute(await parts.prepare());
      expect(result.status).toBe('completed');
      expect(result.output).toContain(forge.urlOf(1));
      expect(forge.openPullsFor('feature/x', 'main')).toHaveLength(1);
      expect(forge.creates()).toBe(1);
    });

    it('sends no create request when the head branch is no longer at the approved commit, and names both commits', async () => {
      const { forge, world, tool } = await setup(shape);
      const parts = partsOf(tool('PullRequestCreate'), CREATE, contextFor(world.work, world.env));
      const prepared = await parts.prepare();
      forge.branchSha.set('feature/x', OTHER_SHA);
      const result = await parts.execute(prepared);
      expect(result.status).toBe('failed');
      expect(result.output).toContain('the precondition does not hold, so nothing was sent');
      expect(result.output).toContain(HEAD_SHA);
      expect(result.output).toContain(OTHER_SHA);
      expect(forge.creates()).toBe(0);
      expect(forge.openPullsFor('feature/x', 'main')).toEqual([]);
    });

    it('finds an existing pull request at prepare and completes as already applied with zero create requests (the duplicate sweep)', async () => {
      const { forge, world, tool } = await setup(shape);
      forge.pulls.push({ number: 1, head: 'feature/x', base: 'main', headSha: HEAD_SHA, title: 'made by a person', state: 'open', merged: false });
      const parts = partsOf(tool('PullRequestCreate'), CREATE, contextFor(world.work, world.env));
      const result = await parts.execute(await parts.prepare());
      expect(result).toMatchObject({ status: 'completed', effect: { operation: 'PullRequestCreate', outcome: 'already_applied' } });
      expect(result.output).toContain(forge.urlOf(1));
      expect(forge.creates()).toBe(0);
      expect(forge.openPullsFor('feature/x', 'main')).toHaveLength(1);
    });

    it('reports the same URL after the effect landed and the response was lost, with one pull request (crash c3, G5, G6)', async () => {
      const { forge, world, tool } = await setup(shape);
      const parts = partsOf(tool('PullRequestCreate'), CREATE, contextFor(world.work, world.env));
      const prepared = await parts.prepare();
      forge.faultNext('create', 'apply_then_drop');
      await settle(() => parts.execute(prepared));
      const reconciled = await parts.reconcile(prepared, Date.now());
      expect(reconciled.outcome).toBe('already_applied');
      expect(reconciled.output).toContain(forge.urlOf(1));
      expect(forge.openPullsFor('feature/x', 'main')).toHaveLength(1);
      expect(forge.creates()).toBe(1);
    });

    it('reports not_applied after a request lost in flight, and the guarded redo creates exactly one pull request (crash c2)', async () => {
      const { forge, world, tool } = await setup(shape);
      const parts = partsOf(tool('PullRequestCreate'), CREATE, contextFor(world.work, world.env));
      const prepared = await parts.prepare();
      forge.faultNext('create', 'drop_before_apply');
      await settle(() => parts.execute(prepared));
      expect(forge.pulls).toHaveLength(0);
      const reconciled = await parts.reconcile(prepared, Date.now());
      expect(reconciled.outcome).toBe('not_applied');
      const createsBeforeRedo = forge.creates();
      const redo = await parts.execute(prepared);
      expect(redo.status).toBe('completed');
      expect(forge.creates() - createsBeforeRedo).toBe(1);
      expect(forge.openPullsFor('feature/x', 'main')).toHaveLength(1);
    });

    it('never makes a second open pull request even when the redo races an earlier request that landed (G6)', async () => {
      const { forge, world, tool } = await setup(shape);
      const parts = partsOf(tool('PullRequestCreate'), CREATE, contextFor(world.work, world.env));
      const prepared = await parts.prepare();
      forge.faultNext('create', 'apply_then_drop');
      await settle(() => parts.execute(prepared));
      const redo = await settle(() => parts.execute(prepared));
      expect(redo.status).not.toBe('threw');
      expect(forge.openPullsFor('feature/x', 'main')).toHaveLength(1);
    });

    it('reports no forge configured for the remote host and sends nothing when no instance matches', async () => {
      const { forge, world, tool } = await setup(shape, 'forge.invalid');
      const parts = partsOf(tool('PullRequestCreate'), CREATE, contextFor(world.work, world.env));
      const outcome = await settle(async () => parts.execute(await parts.prepare()));
      expect(outcome.status).not.toBe('completed');
      expect(outcome.output).toContain(`no forge configured for host ${forge.host}`);
      expect(forge.requests).toEqual([]);
    });
  });

  describe('PullRequestMerge', () => {
    it('merges with the expected head sha', async () => {
      const { forge, world, tool } = await setup(shape);
      forge.pulls.push({ number: 1, head: 'feature/x', base: 'main', headSha: HEAD_SHA, title: 't', state: 'open', merged: false });
      const parts = partsOf(tool('PullRequestMerge'), { number: 1, headSha: HEAD_SHA }, contextFor(world.work, world.env));
      const result = await parts.execute(await parts.prepare());
      expect(result.status).toBe('completed');
      expect(forge.pulls[0]?.merged).toBe(true);
      expect(forge.merges()).toBe(1);
    });

    it('fails with the new head and sends no merge request when the head moved since approval (G7)', async () => {
      const { forge, world, tool } = await setup(shape);
      forge.pulls.push({ number: 1, head: 'feature/x', base: 'main', headSha: OTHER_SHA, title: 't', state: 'open', merged: false });
      const parts = partsOf(tool('PullRequestMerge'), { number: 1, headSha: HEAD_SHA }, contextFor(world.work, world.env));
      const result = await parts.execute(await parts.prepare());
      expect(result.status).toBe('failed');
      expect(result.output).toContain(OTHER_SHA);
      expect(forge.merges()).toBe(0);
      expect(forge.pulls[0]?.merged).toBe(false);
    });

    it('finds the merge applied after the response was lost and does not merge again (crash c3)', async () => {
      const { forge, world, tool } = await setup(shape);
      forge.pulls.push({ number: 1, head: 'feature/x', base: 'main', headSha: HEAD_SHA, title: 't', state: 'open', merged: false });
      const parts = partsOf(tool('PullRequestMerge'), { number: 1, headSha: HEAD_SHA }, contextFor(world.work, world.env));
      const prepared = await parts.prepare();
      forge.faultNext('merge', 'apply_then_drop');
      await settle(() => parts.execute(prepared));
      const reconciled = await parts.reconcile(prepared, Date.now());
      expect(reconciled.outcome).toBe('already_applied');
      expect(forge.merges()).toBe(1);
    });
  });

  describe('PullRequestComment, whose guard is none', () => {
    it('answers unknown after a request lost in flight and never posts again (G3, G4)', async () => {
      const { forge, world, tool } = await setup(shape);
      forge.pulls.push({ number: 1, head: 'feature/x', base: 'main', headSha: HEAD_SHA, title: 't', state: 'open', merged: false });
      const parts = partsOf(tool('PullRequestComment'), { number: 1, body: 'Thanks' }, contextFor(world.work, world.env));
      const prepared = await parts.prepare();
      forge.faultNext('comment', 'drop_before_apply');
      await settle(() => parts.execute(prepared));
      const reconciled = await parts.reconcile(prepared, Date.now());
      expect(reconciled.outcome).toBe('unknown');
      expect(forge.commentPosts()).toBe(1);
      expect(forge.comments.get(1) ?? []).toEqual([]);
    });

    it('finds the comment applied by its marker after the response was lost', async () => {
      const { forge, world, tool } = await setup(shape);
      forge.pulls.push({ number: 1, head: 'feature/x', base: 'main', headSha: HEAD_SHA, title: 't', state: 'open', merged: false });
      const parts = partsOf(tool('PullRequestComment'), { number: 1, body: 'Thanks' }, contextFor(world.work, world.env));
      const prepared = await parts.prepare();
      forge.faultNext('comment', 'apply_then_drop');
      await settle(() => parts.execute(prepared));
      const reconciled = await parts.reconcile(prepared, Date.now());
      expect(reconciled.outcome).toBe('already_applied');
      expect(forge.commentPosts()).toBe(1);
      expect(forge.comments.get(1)).toHaveLength(1);
      expect(forge.comments.get(1)?.[0]).toContain('Thanks');
    });
  });

  describe('PullRequestStatus', () => {
    it('reads the state and head of a pull request without changing anything', async () => {
      const { forge, world, tool } = await setup(shape);
      forge.pulls.push({ number: 1, head: 'feature/x', base: 'main', headSha: HEAD_SHA, title: 't', state: 'open', merged: false });
      const read = await tool('PullRequestStatus').execute({ number: 1 }, contextFor(world.work, world.env), undefined);
      expect(read).toMatchObject({ status: 'completed' });
      expect((read as { output: string }).output).toContain(HEAD_SHA);
      expect(forge.requests.every((request) => request.method === 'GET')).toBe(true);
    });
  });

  describe('the credential (G8)', () => {
    it('is read by reference at call time and sent only in the forge request header', async () => {
      const { forge, world, credentialReads, tool } = await setup(shape);
      const parts = partsOf(tool('PullRequestCreate'), CREATE, contextFor(world.work, world.env));
      await parts.execute(await parts.prepare());
      expect(credentialReads.length).toBeGreaterThan(0);
      expect(credentialReads.every((entry) => entry === JSON.stringify({ env: 'FAKE_FORGE_TOKEN' }))).toBe(true);
      expect(forge.requests.length).toBeGreaterThan(0);
    });

    it('appears in no result, reconcile output or error, even when the forge echoes it back', async () => {
      const { forge, world, tool } = await setup(shape);
      const ctx = contextFor(world.work, world.env);
      const texts: string[] = [];
      const create = partsOf(tool('PullRequestCreate'), CREATE, ctx);
      const prepared = await create.prepare().catch((error: unknown) => {
        texts.push(String(error));
        return undefined;
      });
      texts.push(JSON.stringify(prepared ?? null));
      forge.faultNext('any', 'echo_authorization_500');
      texts.push(JSON.stringify(await settle(() => create.execute(prepared))));
      texts.push(JSON.stringify(await create.reconcile(prepared, Date.now()).catch((error: unknown) => String(error))));
      forge.faultNext('any', 'echo_authorization_500');
      texts.push(JSON.stringify(await settle(async () => tool('PullRequestStatus').execute({ number: 1 }, ctx, undefined) as never)));
      expect(forge.requests.length).toBeGreaterThan(0);
      for (const text of texts) expect(text).not.toContain(CREDENTIAL);
      expect(JSON.stringify(ctx.env)).not.toContain(CREDENTIAL);
    });
  });
});
