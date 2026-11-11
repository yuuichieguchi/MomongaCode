import { describe, expect, it } from 'vitest';
import { createForgeAccess, loadForgeDescriptors } from '@momonga/tools';
import type { ForgeDescriptor, ForgeFetch } from '@momonga/tools';
import { GITHUB_CONTRACT, GITHUB_REFUSALS, startFakeForge } from '@momonga/testkit';
import { TEST_FETCH, onCleanup } from './support.ts';

const CREDENTIAL = 'fake-forge-credential-for-tests';
const HEAD_SHA = 'a'.repeat(40);
const ARGS = { head: 'feature/x', base: 'main', title: 't', body: 'b', number: '1', headSha: HEAD_SHA, branch: 'feature/x' };

const github = (): ForgeDescriptor => {
  const shipped = loadForgeDescriptors().find((descriptor) => descriptor.id === 'github');
  if (shipped === undefined) throw new Error('no shipped descriptor with id github');
  return shipped;
};

type Operation = keyof ForgeDescriptor['operations'];

const operations = Object.keys(github().operations) as Operation[];

const accessOn = (apiBaseUrl: string, fetch: ForgeFetch) =>
  createForgeAccess({
    descriptors: [github()],
    instances: [{ id: 'gh', descriptor: 'github', hosts: [new URL(apiBaseUrl).host], apiBaseUrl, credential: { env: 'FAKE_FORGE_TOKEN' } }],
    fetch,
    readCredential: async () => CREDENTIAL,
  });

const ask = (access: ReturnType<typeof accessOn>, host: string, operation: Operation) =>
  access.request({ remoteUrl: `https://${host}/acme/widgets.git`, operation, args: ARGS, signal: new AbortController().signal, boundMs: 5000 });

const documented =
  (status: number, body: unknown): ForgeFetch =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const keysOf = (fields: Readonly<Record<string, string>>): string[] => Object.keys(fields).sort();

describe('the GitHub descriptor against the documented answers of GitHub', () => {
  it('has a documented answer for every operation it declares', () => {
    expect(Object.keys(GITHUB_CONTRACT).sort()).toEqual([...operations].sort());
  });

  it.each(operations)('reads the documented answer of %s into its fields', async (operation) => {
    const contract = GITHUB_CONTRACT[operation];
    if (contract === undefined) throw new Error(`no documented answer for ${operation}`);
    const answer = await ask(accessOn('https://api.forge.example', documented(contract.status, contract.body)), 'api.forge.example', operation);

    expect(answer.status).toBe('success');
    expect(Array.isArray(contract.expected) ? answer.items : answer.fields).toEqual(contract.expected);
  });

  it('reads the documented refusals of a pull request create', async () => {
    const access = (body: unknown) => accessOn('https://api.forge.example', documented(422, body));

    expect((await ask(access(GITHUB_REFUSALS.alreadyExists), 'api.forge.example', 'createPullRequest')).status).toBe('already_exists');
    expect(await ask(access(GITHUB_REFUSALS.noCommits), 'api.forge.example', 'createPullRequest')).toMatchObject({ status: 'failed', message: expect.stringContaining('No commits between master and new-topic') });
  });
});

describe('the fake forge against the documented answers of GitHub', () => {
  it.each(operations)('answers %s with the fields the documented answer has', async (operation) => {
    const forge = await startFakeForge('hub', CREDENTIAL);
    onCleanup(() => forge.close());
    forge.branchSha.set('feature/x', HEAD_SHA);
    forge.branchSha.set('main', 'b'.repeat(40));
    if (operation !== 'createPullRequest') forge.pulls.push({ number: 1, head: 'feature/x', base: 'main', headSha: HEAD_SHA, title: 't', state: 'open', merged: false });
    forge.comments.set(1, ['Me too']);
    forge.reviewComments.set(1, [{ path: 'file1.txt', line: 2, body: 'Great stuff!' }]);
    forge.checks.set(HEAD_SHA, [{ name: 'mighty_readme', status: 'completed', conclusion: 'neutral' }]);
    const contract = GITHUB_CONTRACT[operation];
    if (contract === undefined) throw new Error(`no documented answer for ${operation}`);

    const answer = await ask(accessOn(forge.origin, TEST_FETCH), forge.host, operation);

    expect(answer.status).toBe('success');
    if (Array.isArray(contract.expected)) {
      expect(answer.items.map(keysOf)).toEqual(contract.expected.map(keysOf));
    } else {
      expect(keysOf(answer.fields)).toEqual(keysOf(contract.expected as Readonly<Record<string, string>>));
    }
  });

  it('refuses a pull request create with the bodies GitHub documents', async () => {
    const forge = await startFakeForge('hub', CREDENTIAL);
    onCleanup(() => forge.close());
    forge.branchSha.set('feature/x', HEAD_SHA);
    forge.branchSha.set('main', HEAD_SHA);
    const refused = await fetch(`${forge.origin}/repos/acme/widgets/pulls`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CREDENTIAL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ head: 'feature/x', base: 'main', title: 't', body: 'b' }),
    });

    expect(refused.status).toBe(422);
    expect(Object.keys((await refused.json()) as object).sort()).toEqual(Object.keys(GITHUB_REFUSALS.noCommits).sort());
  });
});
