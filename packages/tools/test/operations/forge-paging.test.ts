import { describe, expect, it } from 'vitest';
import { REDACTED_MARKER } from '@momonga/foundation';
import { createForgeAccess, loadForgeDescriptors, parseForgeDescriptor } from '@momonga/tools';
import type { ForgeDescriptor, ForgeFetch } from '@momonga/tools';
import { FAKE_FORGE_LARGEST_PAGE, LAB_DESCRIPTOR, startFakeForge } from '@momonga/testkit';
import type { FakeForge, ForgeShape } from '@momonga/testkit';
import { contextFor, countingRunner, TEST_FETCH, makeGitWorld, onCleanup, operationTool, partsOf } from './support.ts';

const CREDENTIAL = 'fake-forge-credential-for-tests';
const HEAD_SHA = 'a'.repeat(40);
const MANY = FAKE_FORGE_LARGEST_PAGE * 2 + 5;
const FORGE_ORIGIN = 'https://api.forge.example';

const github = (): ForgeDescriptor => {
  const shipped = loadForgeDescriptors().find((descriptor) => descriptor.id === 'github');
  if (shipped === undefined) throw new Error('no shipped descriptor with id github');
  return shipped;
};

const descriptorFor = (shape: ForgeShape): ForgeDescriptor => (shape === 'lab' ? parseForgeDescriptor(LAB_DESCRIPTOR) : github());

const setup = async (shape: ForgeShape): Promise<{ forge: FakeForge; tool(name: string): ReturnType<typeof operationTool>; context: ReturnType<typeof contextFor> }> => {
  const forge = await startFakeForge(shape, CREDENTIAL);
  onCleanup(() => forge.close());
  forge.branchSha.set('feature/x', HEAD_SHA);
  forge.pulls.push({ number: 1, head: 'feature/x', base: 'main', headSha: HEAD_SHA, title: 't', state: 'open', merged: false });
  const world = makeGitWorld();
  world.git(world.work, 'remote', 'set-url', 'origin', `${forge.origin}/acme/widgets.git`);
  const descriptor = descriptorFor(shape);
  const access = createForgeAccess({
    descriptors: [descriptor],
    instances: [{ id: 'local', descriptor: descriptor.id, hosts: [forge.host], apiBaseUrl: forge.origin, credential: { env: 'FAKE_FORGE_TOKEN' } }],
    fetch: TEST_FETCH,
    readCredential: async () => CREDENTIAL,
  });
  return { forge, context: contextFor(world.work, world.env), tool: (name) => operationTool(name, { runArgv: countingRunner().run, forge: access }) };
};

const outputOf = async (setupOf: Awaited<ReturnType<typeof setup>>, name: string, input: Record<string, unknown>): Promise<{ status: string; output: string }> => {
  const parts = partsOf(setupOf.tool(name), input, setupOf.context);
  return (await parts.execute(await parts.prepare())) as { status: string; output: string };
};

describe.each(['hub', 'lab'] as const)('a list the %s forge answers in pages', (shape) => {
  it('is read to its last page, so the marker of a new comment after many others is found and the comment is posted once', async () => {
    const world = await setup(shape);
    world.forge.comments.set(1, Array.from({ length: MANY }, (_, index) => `earlier ${index}`));

    const result = await outputOf(world, 'PullRequestComment', { number: 1, body: 'Thanks' });

    expect(result.status).toBe('completed');
    expect(world.forge.commentPosts()).toBe(1);
    expect(world.forge.comments.get(1)).toHaveLength(MANY + 1);
  });

  it('gives every check of the head commit to PullRequestStatus', async () => {
    const world = await setup(shape);
    world.forge.checks.set(HEAD_SHA, Array.from({ length: MANY }, (_, index) => ({ name: `check-${index}`, status: 'completed', conclusion: 'success' })));

    const result = await outputOf(world, 'PullRequestStatus', { number: 1 });

    expect(result.output).toContain(`${MANY} checks`);
    expect(result.output).toContain(`check-${MANY - 1}: success`);
  });

  it('gives every review comment to PullRequestComments', async () => {
    const world = await setup(shape);
    world.forge.reviewComments.set(1, Array.from({ length: MANY }, (_, index) => ({ path: 'src/a.ts', line: index + 1, body: `note ${index}` })));

    const result = await outputOf(world, 'PullRequestComments', { number: 1 });

    expect(result.output).toContain(`${MANY} review comments`);
    expect(result.output).toContain(`note ${MANY - 1}`);
  });
});

const answering =
  (status: number, body: unknown, headers: Record<string, string> = {}): ForgeFetch =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const accessWith = (fetch: ForgeFetch) =>
  createForgeAccess({
    descriptors: [github()],
    instances: [{ id: 'gh', descriptor: 'github', hosts: ['forge.example'], apiBaseUrl: FORGE_ORIGIN, credential: { env: 'FAKE_FORGE_TOKEN' } }],
    fetch,
    readCredential: async () => CREDENTIAL,
  });

const requestOf = (fetch: ForgeFetch, operation: 'createPullRequest' | 'listComments') =>
  accessWith(fetch).request({
    remoteUrl: 'https://forge.example/acme/widgets.git',
    operation,
    args: { head: 'feature/x', base: 'main', title: 't', body: 'b', number: '1' },
    signal: new AbortController().signal,
    boundMs: 1000,
  });

const validationFailed = (message: string) => ({ message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message }], documentation_url: 'https://docs.github.com/rest' });

describe('a status the forge answers', () => {
  it('is already_exists only when GitHub says that a pull request already exists', async () => {
    const answer = await requestOf(answering(422, validationFailed('A pull request already exists for acme:feature/x.')), 'createPullRequest');

    expect(answer.status).toBe('already_exists');
  });

  it('is failed with the forge message, redacted, for every other 422', async () => {
    const answer = await requestOf(answering(422, validationFailed(`No commits between main and feature/x (${CREDENTIAL})`)), 'createPullRequest');

    expect(answer.status).toBe('failed');
    expect(answer.message).toContain('Validation Failed');
    expect(answer.message).toContain('No commits between main and feature/x');
    expect(answer.message).toContain(REDACTED_MARKER);
    expect(answer.message).not.toContain(CREDENTIAL);
  });

  it('names the forge message when no entry of the descriptor takes the status', async () => {
    await expect(requestOf(answering(403, { message: 'Resource not accessible by integration' }), 'createPullRequest')).rejects.toThrow(/status 403: Resource not accessible by integration/);
  });

  it('refuses a next page on another origin than the forge', async () => {
    const fetch = answering(200, [], { link: '<https://elsewhere.example/repos/acme/widgets/issues/1/comments?page=2>; rel="next"' });

    await expect(requestOf(fetch, 'listComments')).rejects.toThrow(/next page .*elsewhere\.example/);
  });
});

describe('PullRequestCreate when the forge refuses it', () => {
  it('fails with the reason of the forge, not as already existing', async () => {
    const world = await setup('hub');
    world.forge.branchSha.set('main', HEAD_SHA);
    world.forge.pulls.length = 0;

    const result = await outputOf(world, 'PullRequestCreate', { head: 'feature/x', base: 'main', title: 'Add x', body: 'Adds x', headSha: HEAD_SHA });

    expect(result.status).toBe('failed');
    expect(result.output).toContain('No commits between main and feature/x');
    expect(result.output).not.toContain('already exists');
    expect(world.forge.creates()).toBe(1);
  });
});
