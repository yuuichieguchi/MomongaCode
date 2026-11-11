import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { execFile } from '@momonga/testkit/child-process';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startFakeGitHttp } from '@momonga/testkit';
import type { FakeGitHttp } from '@momonga/testkit';
import { createForgeAccess, loadForgeDescriptors, openGitCredentialChannel } from '@momonga/tools';
import type { ForgeAccess } from '@momonga/tools';
import { mintServerCertificate } from '../../../cli/test/minted-certificates.ts';
import { TEST_FETCH, contextFor, countingRunner, makeGitWorld, onCleanup, operationTool, partsOf, settle } from './support.ts';
import type { CountingRunner, GitWorld } from './support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const CREDENTIAL = 'fake-git-credential-for-tests';
const TLS_HOST = 'localhost';

type Setup = { world: GitWorld; server: FakeGitHttp; runner: CountingRunner; credentialReads: string[]; forge(configured: boolean): ForgeAccess };

const setup = async (): Promise<Setup> => {
  const world = makeGitWorld();
  const served = path.join(world.base, 'served');
  fs.mkdirSync(path.join(served, 'acme'), { recursive: true });
  fs.renameSync(world.bare, path.join(served, 'acme', 'widgets.git'));
  const minted = mintServerCertificate(TLS_HOST);
  const caFile = path.join(world.base, 'ca.pem');
  fs.writeFileSync(caFile, minted.caPem);
  fs.appendFileSync(world.env['GIT_CONFIG_GLOBAL'] as string, `[http]\n\tsslCAInfo = ${caFile}\n`);
  const descriptor = loadForgeDescriptors()[0];
  if (descriptor === undefined) throw new Error('no shipped forge descriptor');
  const server = await startFakeGitHttp({ projectRoot: served, username: descriptor.auth.gitUsername, password: CREDENTIAL, tls: { certPem: minted.certPem, keyPem: minted.keyPem, host: TLS_HOST } });
  onCleanup(() => server.close());
  world.git(world.work, 'remote', 'set-url', 'origin', `${server.origin}/acme/widgets.git`);
  world.write('a.txt', 'one\n');
  world.commitAll('base');
  const credentialReads: string[] = [];
  const forge = (configured: boolean): ForgeAccess =>
    createForgeAccess({
      descriptors: [descriptor],
      instances: configured ? [{ id: 'local', descriptor: descriptor.id, host: server.host, apiBaseUrl: 'http://127.0.0.1:9', credential: { env: 'FAKE_FORGE_TOKEN' } }] : [],
      fetch: TEST_FETCH,
      readCredential: async (reference) => {
        credentialReads.push(JSON.stringify(reference));
        return CREDENTIAL;
      },
    });
  return { world, server, runner: countingRunner(), credentialReads, forge };
};

const remoteMain = (world: GitWorld): string => world.git(path.join(world.base, 'served', 'acme', 'widgets.git'), 'rev-parse', '--verify', '-q', 'refs/heads/main');

describe('an https git push gets the credential of the forge entry by reference', () => {
  it('pushes to a remote that requires the credential, and the credential is in no argument and no environment of a child', async () => {
    const { world, server, runner, credentialReads, forge } = await setup();
    const parts = partsOf(operationTool('GitPush', { runArgv: runner.run, forge: forge(true) }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result).toMatchObject({ status: 'completed', effect: { operation: 'GitPush', outcome: 'applied' } });
    expect(remoteMain(world)).toBe(world.git(world.work, 'rev-parse', 'HEAD'));
    expect(server.served()).toBeGreaterThan(0);
    expect(credentialReads.length).toBeGreaterThan(0);
    expect(new Set(credentialReads)).toEqual(new Set([JSON.stringify({ env: 'FAKE_FORGE_TOKEN' })]));
    expect(runner.calls.flat().some((argument) => argument.includes(CREDENTIAL))).toBe(false);
    expect(runner.environments.some((env) => Object.values(env).some((value) => value.includes(CREDENTIAL)))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
    expect(world.git(world.work, 'config', '--get', 'remote.origin.url')).not.toContain(CREDENTIAL);
  });

  it('pushes nothing when no forge entry names the host: git is given no credential and may not prompt', async () => {
    const { world, server, runner, credentialReads, forge } = await setup();
    const parts = partsOf(operationTool('GitPush', { runArgv: runner.run, forge: forge(false) }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    const result = await settle(async () => parts.execute(await parts.prepare()));
    expect(result.status).not.toBe('completed');
    expect(world.gitStatus(path.join(world.base, 'served', 'acme', 'widgets.git'), 'rev-parse', '--verify', '-q', 'refs/heads/main')).not.toBe(0);
    expect(server.served()).toBe(0);
    expect(credentialReads).toEqual([]);
  });

  it('fetches over https with the same credential', async () => {
    const { world, runner, forge } = await setup();
    world.git(path.join(world.base, 'served', 'acme', 'widgets.git'), 'config', 'http.receivepack', 'true');
    const pushed = partsOf(operationTool('GitPush', { runArgv: runner.run, forge: forge(true) }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    await pushed.execute(await pushed.prepare());
    const parts = partsOf(operationTool('GitFetch', { runArgv: runner.run, forge: forge(true) }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result.status).toBe('completed');
    expect(world.git(world.work, 'rev-parse', 'refs/remotes/origin/main')).toBe(world.git(world.work, 'rev-parse', 'HEAD'));
  });
});

const ask = (env: Readonly<Record<string, string>>, prompt: string): Promise<{ code: number; stdout: string }> =>
  new Promise((resolve) => {
    execFile(env['GIT_ASKPASS'] as string, [prompt], { env: { ...env }, encoding: 'utf8' }, (error, stdout) => {
      resolve({ code: error === null ? 0 : 1, stdout });
    });
  });

describe('the credential channel of a git child', () => {
  const open = async () => {
    const channel = await openGitCredentialChannel([{ host: 'forge.example', username: 'x-access-token', password: CREDENTIAL }], { root: os.tmpdir() });
    onCleanup(() => channel.close());
    const env = channel.environment({ PATH: process.env['PATH'] ?? '/usr/bin:/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat' });
    return { channel, env };
  };

  it('answers the user name and the password of its host once each, and nothing a second time', async () => {
    const { env } = await open();
    expect(await ask(env, "Username for 'https://forge.example': ")).toEqual({ code: 0, stdout: 'x-access-token\n' });
    expect(await ask(env, "Password for 'https://x-access-token@forge.example': ")).toEqual({ code: 0, stdout: `${CREDENTIAL}\n` });
    expect(await ask(env, "Password for 'https://x-access-token@forge.example': ")).toEqual({ code: 1, stdout: '' });
  });

  it('answers nothing for another host, and nothing to a caller without the nonce of the child', async () => {
    const { env } = await open();
    expect(await ask(env, "Password for 'https://x-access-token@elsewhere.example': ")).toEqual({ code: 1, stdout: '' });
    expect(await ask({ ...env, MOMONGA_GIT_CREDENTIAL_NONCE: '0'.repeat(64) }, "Password for 'https://x-access-token@forge.example': ")).toEqual({ code: 1, stdout: '' });
  });

  it('turns the credential helpers of the user off for the child and keeps the configuration the child already had', async () => {
    const { env } = await open();
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GIT_TERMINAL_PROMPT: '0' });
    expect(Object.values(env).some((value) => value.includes(CREDENTIAL))).toBe(false);
  });

  it('keeps its files private and removes them when it closes', async () => {
    const { channel } = await open();
    expect(fs.statSync(channel.directory).mode & 0o077).toBe(0);
    const files = fs.readdirSync(channel.directory).filter((name) => fs.statSync(path.join(channel.directory, name)).isFile());
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((name) => fs.readFileSync(path.join(channel.directory, name), 'utf8').includes(CREDENTIAL))).toBe(false);
    await channel.close();
    expect(fs.existsSync(channel.directory)).toBe(false);
  });

  it('removes the credential from the output of the child', async () => {
    const { channel } = await open();
    expect(channel.redact(`fatal: ${CREDENTIAL} refused`)).toBe('fatal: [redacted] refused');
  });
});
