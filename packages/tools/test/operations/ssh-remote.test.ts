import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startFakeGitHttp } from '@momonga/testkit';
import { createForgeAccess, loadForgeDescriptors } from '@momonga/tools';
import type { ForgeInstance } from '@momonga/tools';
import { mintServerCertificate } from '../../../cli/test/minted-certificates.ts';
import { TEST_FETCH, contextFor, countingRunner, gateFactsFor, makeGitWorld, onCleanup, operationTool, partsOf, settle, subjectFor } from './support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const CREDENTIAL = 'fake-forge-credential-for-tests';
const TLS_HOST = 'localhost';
const SSH_PORT = 2222;
const PUSH = { remote: 'origin', branch: 'main' };

const descriptorOfGithub = () => {
  const descriptor = loadForgeDescriptors().find((candidate) => candidate.id === 'github');
  if (descriptor === undefined) throw new Error('no shipped descriptor with id github');
  return descriptor;
};

const setup = async (declared: 'declared' | 'undeclared' = 'declared') => {
  const world = makeGitWorld();
  const served = path.join(world.base, 'served');
  const bare = path.join(served, 'acme', 'widgets.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  fs.renameSync(world.bare, bare);
  const minted = mintServerCertificate(TLS_HOST);
  const caFile = path.join(world.base, 'ca.pem');
  fs.writeFileSync(caFile, minted.caPem);
  fs.appendFileSync(world.env['GIT_CONFIG_GLOBAL'] as string, `[http]\n\tsslCAInfo = ${caFile}\n`);
  const descriptor = descriptorOfGithub();
  const gitServer = await startFakeGitHttp({ projectRoot: served, username: descriptor.auth.gitUsername, password: CREDENTIAL, tls: { certPem: minted.certPem, keyPem: minted.keyPem, host: TLS_HOST } });
  onCleanup(() => gitServer.close());
  const instances: ForgeInstance[] = declared === 'declared' ? [{ id: 'local', descriptor: descriptor.id, hosts: [gitServer.host], apiBaseUrl: 'https://api.forge.invalid', credential: { env: 'FAKE_FORGE_TOKEN' } }] : [];
  const forge = createForgeAccess({ descriptors: [descriptor], instances, fetch: TEST_FETCH, readCredential: async () => CREDENTIAL });
  world.write('a.txt', 'one\n');
  const head = world.commitAll('first');
  const runner = countingRunner();
  const https = `${gitServer.origin}/acme/widgets.git`;
  const tool = (name: string) => operationTool(name, { runArgv: runner.run, forge });
  const remoteSha = (branch: string): string => world.git(bare, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`);
  const setRemote = (...args: string[]): string => world.git(world.work, 'remote', 'set-url', ...args);
  const personConfig = (key: string, value: string): string => world.git(world.work, 'config', '--global', key, value);
  return { world, bare, head, runner, https, gitServer, tool, remoteSha, setRemote, personConfig };
};

const SSH_FORMS: ReadonlyArray<readonly [string, string]> = [
  ['the scp form', `git@${TLS_HOST}:acme/widgets.git`],
  ['the ssh URL with a port of its own', `ssh://git@${TLS_HOST}:${SSH_PORT}/acme/widgets.git`],
  ['the scp form without the .git ending', `git@${TLS_HOST}:acme/widgets`],
];

describe.each(SSH_FORMS)('GitPush to a remote written in %s, on a declared forge', (_form, remoteUrl) => {
  it('names the HTTPS place of the forge in its approval, reads and pushes there with the credential of the forge, and leaves the remote as the person wrote it', async () => {
    const { world, head, runner, https, gitServer, tool, remoteSha, setRemote } = await setup();
    setRemote('origin', remoteUrl);
    const subject = await subjectFor(tool('GitPush'), PUSH, world);
    expect(subject).toMatchObject({ kind: 'repo', destinations: [https], destinationsMatchFetch: true });
    const parts = partsOf(tool('GitPush'), PUSH, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result).toMatchObject({ status: 'completed' });
    expect(remoteSha('main')).toBe(head);
    const probes = runner.calls.filter((argv) => argv.includes('ls-remote'));
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) expect(probe).toContain(https);
    expect(runner.calls.flat().filter((argument) => argument === remoteUrl)).toEqual([]);
    expect(gitServer.served()).toBeGreaterThan(0);
    expect(world.git(world.work, 'remote', 'get-url', '--push', 'origin')).toBe(remoteUrl);
    expect(world.git(world.work, 'config', '--get-all', 'remote.origin.url')).toBe(remoteUrl);
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
  });
});

describe('GitFetch from a remote written in the scp form, on a declared forge', () => {
  it('fetches over the HTTPS place of the forge into the remote-tracking branch', async () => {
    const { world, head, https, tool, setRemote, bare } = await setup();
    world.git(world.work, 'push', '-q', bare, 'main');
    setRemote('origin', `git@${TLS_HOST}:acme/widgets.git`);
    const input = { remote: 'origin', branch: 'main' };
    expect(await subjectFor(tool('GitFetch'), input, world)).toMatchObject({ destinations: [https] });
    const parts = partsOf(tool('GitFetch'), input, contextFor(world.work, world.env));
    expect(await parts.execute(await parts.prepare())).toMatchObject({ status: 'completed' });
    expect(world.git(world.work, 'rev-parse', 'refs/remotes/origin/main')).toBe(head);
  });
});

describe('GitPush when the configuration of the person rewrites URLs to SSH', () => {
  it('still reaches the HTTPS place of the forge when the remote is an HTTPS URL that the person rewrites to the scp form', async () => {
    const { world, head, https, gitServer, tool, remoteSha, setRemote, personConfig } = await setup();
    setRemote('origin', https);
    personConfig(`url.git@${TLS_HOST}:.insteadOf`, `${gitServer.origin}/`);
    expect(world.git(world.work, 'remote', 'get-url', '--push', 'origin')).toBe(`git@${TLS_HOST}:acme/widgets.git`);
    const parts = partsOf(tool('GitPush'), PUSH, contextFor(world.work, world.env));
    expect(await parts.execute(await parts.prepare())).toMatchObject({ status: 'completed' });
    expect(remoteSha('main')).toBe(head);
  });

  it('still reaches the HTTPS place of the forge when the remote is a short name that the person rewrites to the scp form', async () => {
    const { world, head, https, tool, remoteSha, setRemote, personConfig } = await setup();
    setRemote('origin', 'lh:acme/widgets.git');
    personConfig(`url.git@${TLS_HOST}:.insteadOf`, 'lh:');
    expect(await subjectFor(tool('GitPush'), PUSH, world)).toMatchObject({ destinations: [https] });
    const parts = partsOf(tool('GitPush'), PUSH, contextFor(world.work, world.env));
    expect(await parts.execute(await parts.prepare())).toMatchObject({ status: 'completed' });
    expect(remoteSha('main')).toBe(head);
  });

  it('still reaches the HTTPS place of the forge when the person rewrites only pushes to the scp form', async () => {
    const { world, head, https, gitServer, tool, remoteSha, setRemote, personConfig } = await setup();
    setRemote('origin', https);
    personConfig(`url.git@${TLS_HOST}:.pushInsteadOf`, `${gitServer.origin}/`);
    expect(world.git(world.work, 'remote', 'get-url', '--push', 'origin')).toBe(`git@${TLS_HOST}:acme/widgets.git`);
    const parts = partsOf(tool('GitPush'), PUSH, contextFor(world.work, world.env));
    expect(await parts.execute(await parts.prepare())).toMatchObject({ status: 'completed' });
    expect(remoteSha('main')).toBe(head);
  });
});

describe('a remote that is reached over SSH and is on no declared forge', () => {
  it('is refused for GitPush before any probe, with the two ways forward', async () => {
    const { world, runner, tool, setRemote } = await setup('undeclared');
    setRemote('origin', 'git@github.com:acme/widgets.git');
    const ctx = contextFor(world.work, world.env);
    const refused = await settle(async () => {
      await gateFactsFor(tool('GitPush'), PUSH, ctx);
      return { status: 'completed', output: '' };
    });
    expect(refused.status).toBe('threw');
    expect(refused.output).toBe(
      'GitPush was not run: the remote origin is at git@github.com:acme/widgets.git, which is not reached over HTTP or HTTPS. This remote is not on a declared forge. Declare the forge in settings (forges), or set an HTTPS push URL with `git remote set-url --push origin https://...`.',
    );
    expect(runner.calls.filter((argv) => argv.includes('ls-remote') || argv.includes('push'))).toEqual([]);
  });

  it('is refused for GitFetch with the command that sets the URL it fetches from', async () => {
    const { world, tool, setRemote } = await setup('undeclared');
    setRemote('origin', 'ssh://git@elsewhere.invalid/acme/widgets.git');
    const ctx = contextFor(world.work, world.env);
    const refused = await settle(async () => {
      await gateFactsFor(tool('GitFetch'), PUSH, ctx);
      return { status: 'completed', output: '' };
    });
    expect(refused.output).toBe(
      'GitFetch was not run: the remote origin is at ssh://git@elsewhere.invalid/acme/widgets.git, which is not reached over HTTP or HTTPS. This remote is not on a declared forge. Declare the forge in settings (forges), or set an HTTPS URL with `git remote set-url origin https://...`.',
    );
  });

  it('is pushed to once the person has set an HTTPS push URL, although the URL it fetches from stays as it was', async () => {
    const { world, head, https, tool, remoteSha, setRemote } = await setup();
    setRemote('origin', 'git@elsewhere.invalid:acme/widgets.git');
    setRemote('--push', 'origin', https);
    expect(await subjectFor(tool('GitPush'), PUSH, world)).toMatchObject({ destinations: [https], destinationsMatchFetch: false });
    const parts = partsOf(tool('GitPush'), PUSH, contextFor(world.work, world.env));
    expect(await parts.execute(await parts.prepare())).toMatchObject({ status: 'completed' });
    expect(remoteSha('main')).toBe(head);
  });
});

describe('the HTTPS place of a remote on a declared forge', () => {
  const access = (host: string) => createForgeAccess({ descriptors: [descriptorOfGithub()], instances: [{ id: 'f', descriptor: 'github', hosts: [host], apiBaseUrl: 'https://api.forge.invalid', credential: { env: 'T' } }], fetch: TEST_FETCH, readCredential: async () => CREDENTIAL });

  it.each([
    ['git@github.com:acme/widgets.git', 'https://github.com/acme/widgets.git'],
    ['git@GitHub.com:acme/widgets', 'https://github.com/acme/widgets.git'],
    ['ssh://git@github.com:22/acme/widgets.git', 'https://github.com/acme/widgets.git'],
    ['git://github.com/acme/widgets.git', 'https://github.com/acme/widgets.git'],
    ['ssh://git@GitHub.com/acme/widgets.git', 'https://github.com/acme/widgets.git'],
    ['git@github.com:group/sub group/widgets.git', 'https://github.com/group/sub%20group/widgets.git'],
  ])('of %s is %s', (remoteUrl, expected) => {
    expect(access('github.com').gitDestination(remoteUrl)).toBe(expected);
  });

  it('keeps the HTTPS port the forge is declared with, not the SSH port of the remote', () => {
    expect(access('forge.example:8443').gitDestination('ssh://git@forge.example:2222/acme/widgets.git')).toBe('https://forge.example:8443/acme/widgets.git');
  });

  it('is none for a remote on another host', () => {
    expect(access('github.com').gitDestination('git@elsewhere.invalid:acme/widgets.git')).toBeUndefined();
  });
});
