import { describe, expect, it } from 'vitest';
import { createForgeAccess, loadForgeDescriptors } from '@momonga/tools';
import type { ForgeDescriptor, ForgeFetch } from '@momonga/tools';

const CREDENTIAL = 'fake-forge-credential-for-tests';

const github = (): ForgeDescriptor => {
  const shipped = loadForgeDescriptors().find((descriptor) => descriptor.id === 'github');
  if (shipped === undefined) throw new Error('no shipped descriptor with id github');
  return shipped;
};

const accessFor = (hosts: readonly string[], asked: URL[]) => {
  const fetch: ForgeFetch = async (url) => {
    asked.push(url);
    return new Response(JSON.stringify({ name: 'main', commit: { sha: 'c'.repeat(40) } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return createForgeAccess({ descriptors: [github()], instances: [{ id: 'gh', descriptor: 'github', hosts, apiBaseUrl: 'https://api.github.com', credential: { env: 'GITHUB_TOKEN' } }], fetch, readCredential: async () => CREDENTIAL });
};

const signal = new AbortController().signal;

describe('the hosts of a forge', () => {
  it('match a remote by the canonical lower-case name on both sides', async () => {
    const asked: URL[] = [];
    const access = accessFor(['GitHub.com'], asked);

    const answer = await access.request({ remoteUrl: 'https://github.com/acme/widgets.git', operation: 'getBranch', args: { branch: 'main' }, signal, boundMs: 1000 });

    expect(answer.fields).toEqual({ sha: 'c'.repeat(40) });
    expect(asked.map((url) => url.origin)).toEqual(['https://api.github.com']);
    expect(await access.gitCredential('https://github.com/acme/widgets.git', signal)).toMatchObject({ origin: 'https://github.com', password: CREDENTIAL });
    expect(access.gitDestination('git@GITHUB.COM:acme/widgets.git')).toBe('https://github.com/acme/widgets.git');
  });

  it('are each a host of the one forge', async () => {
    const asked: URL[] = [];
    const access = accessFor(['github.com', 'ssh.github.com'], asked);

    await access.request({ remoteUrl: 'https://ssh.github.com/acme/widgets.git', operation: 'getBranch', args: { branch: 'main' }, signal, boundMs: 1000 });

    expect(asked).toHaveLength(1);
    expect(await access.gitCredential('https://ssh.github.com/acme/widgets.git', signal)).toMatchObject({ origin: 'https://ssh.github.com' });
    expect(access.gitDestination('git@ssh.github.com:acme/widgets.git')).toBe('https://ssh.github.com/acme/widgets.git');
    expect(await access.gitCredential('https://elsewhere.example/acme/widgets.git', signal)).toBeUndefined();
  });
});
