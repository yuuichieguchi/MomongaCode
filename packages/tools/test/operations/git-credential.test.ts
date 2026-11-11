import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { execFile } from '@momonga/testkit/child-process';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startFakeGitHttp } from '@momonga/testkit';
import type { FakeGitHttp } from '@momonga/testkit';
import { HELPER_COMMAND, REDACTED_MARKER, nodeFileSystem, systemRandom } from '@momonga/foundation';
import type { HelperSelf } from '@momonga/foundation';
import { createForgeAccess, loadForgeDescriptors, openGitCredentialChannel } from '@momonga/tools';
import type { ForgeAccess, GitOriginCredential } from '@momonga/tools';
import { mintServerCertificate } from '../../../cli/test/minted-certificates.ts';
import { ENTRY_AS_SCRIPT, TEST_FETCH, contextFor, countingRunner, makeGitWorld, onCleanup, operationTool, partsOf, settle } from './support.ts';
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

describe('a credential is given only for the origin of a declared forge', () => {
  const access = (host: string) => {
    const reads: string[] = [];
    const descriptor = loadForgeDescriptors()[0];
    if (descriptor === undefined) throw new Error('no shipped forge descriptor');
    const forge = createForgeAccess({
      descriptors: [descriptor],
      instances: [{ id: 'local', descriptor: descriptor.id, host, apiBaseUrl: 'http://127.0.0.1:9', credential: { env: 'FAKE_FORGE_TOKEN' } }],
      fetch: TEST_FETCH,
      readCredential: async (reference) => {
        reads.push(JSON.stringify(reference));
        return CREDENTIAL;
      },
    });
    return { forge, reads, signal: new AbortController().signal };
  };

  it('gives the credential with the origin it is for when the remote is the https origin of the forge', async () => {
    const { forge, signal } = access('forge.example');
    expect(await forge.gitCredential('https://forge.example/acme/widgets.git', signal)).toEqual({ origin: 'https://forge.example', username: 'x-access-token', password: CREDENTIAL });
    expect(await forge.gitCredential('https://person@FORGE.example:443/acme/widgets.git', signal)).toEqual({ origin: 'https://forge.example', username: 'x-access-token', password: CREDENTIAL });
  });

  it('gives nothing and reads no credential for the same host over http', async () => {
    const { forge, reads, signal } = access('forge.example');
    expect(await forge.gitCredential('http://forge.example/acme/widgets.git', signal)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it('gives nothing for the same host on another port, in either direction', async () => {
    const plain = access('forge.example');
    expect(await plain.forge.gitCredential('https://forge.example:8443/acme/widgets.git', plain.signal)).toBeUndefined();
    const withPort = access('forge.example:8443');
    expect(await withPort.forge.gitCredential('https://forge.example/acme/widgets.git', withPort.signal)).toBeUndefined();
    expect(await withPort.forge.gitCredential('https://forge.example:8443/acme/widgets.git', withPort.signal)).toMatchObject({ origin: 'https://forge.example:8443' });
    expect(plain.reads).toEqual([]);
  });

  it('gives nothing for a remote that is not an https URL', async () => {
    const { forge, reads, signal } = access('forge.example');
    expect(await forge.gitCredential('git@forge.example:acme/widgets.git', signal)).toBeUndefined();
    expect(await forge.gitCredential('ssh://git@forge.example/acme/widgets.git', signal)).toBeUndefined();
    expect(await forge.gitCredential('/srv/git/widgets.git', signal)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it('sends no credential to a forge host served over http: the push fails and the server sees no authorization', async () => {
    const world = makeGitWorld();
    const served = path.join(world.base, 'served');
    fs.mkdirSync(path.join(served, 'acme'), { recursive: true });
    fs.renameSync(world.bare, path.join(served, 'acme', 'widgets.git'));
    const descriptor = loadForgeDescriptors()[0];
    if (descriptor === undefined) throw new Error('no shipped forge descriptor');
    const server = await startFakeGitHttp({ projectRoot: served, username: descriptor.auth.gitUsername, password: CREDENTIAL });
    onCleanup(() => server.close());
    world.git(world.work, 'remote', 'set-url', 'origin', `${server.origin}/acme/widgets.git`);
    world.write('a.txt', 'one\n');
    world.commitAll('base');
    const reads: string[] = [];
    const forge = createForgeAccess({
      descriptors: [descriptor],
      instances: [{ id: 'local', descriptor: descriptor.id, host: server.host, apiBaseUrl: 'http://127.0.0.1:9', credential: { env: 'FAKE_FORGE_TOKEN' } }],
      fetch: TEST_FETCH,
      readCredential: async (reference) => {
        reads.push(JSON.stringify(reference));
        return CREDENTIAL;
      },
    });
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitPush', { runArgv: runner.run, forge }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    const result = await settle(async () => parts.execute(await parts.prepare()));
    expect(result.status).not.toBe('completed');
    expect(reads).toEqual([]);
    expect(runner.credentialed.some((given) => given)).toBe(false);
    expect(server.authorizations).toEqual([]);
    expect(server.served()).toBe(0);
  });
});

describe('two push URLs of one origin', () => {
  it('pushes to both: each URL is answered, because the prompt of the child names the path', async () => {
    const { world, runner, forge } = await setup();
    const second = path.join(world.base, 'served', 'acme', 'gadgets.git');
    world.git(world.base, 'init', '--bare', '--initial-branch=main', second);
    const first = world.git(world.work, 'remote', 'get-url', 'origin');
    world.git(world.work, 'remote', 'set-url', '--add', '--push', 'origin', first);
    world.git(world.work, 'remote', 'set-url', '--add', '--push', 'origin', first.replace('widgets.git', 'gadgets.git'));
    const parts = partsOf(operationTool('GitPush', { runArgv: runner.run, forge: forge(true) }), { remote: 'origin', branch: 'main' }, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result).toMatchObject({ status: 'completed', effect: { operation: 'GitPush', outcome: 'applied' } });
    const head = world.git(world.work, 'rev-parse', 'HEAD');
    expect(remoteMain(world)).toBe(head);
    expect(world.git(second, 'rev-parse', '--verify', '-q', 'refs/heads/main')).toBe(head);
  });
});

type Asked = { code: number; stdout: string; stderr: string };

const ask = (env: Readonly<Record<string, string>>, prompt: string): Promise<Asked> =>
  new Promise((resolve) => {
    execFile('sh', [env['GIT_ASKPASS'] as string, prompt], { env: { ...env }, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : 1, stdout, stderr });
    });
  });

const FORGE_CREDENTIAL: GitOriginCredential = { origin: 'https://forge.example', username: 'x-access-token', password: CREDENTIAL };

const channelRoot = (): string => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cred-'));
  onCleanup(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

const open = async (helper: HelperSelf = ENTRY_AS_SCRIPT, credentials: readonly GitOriginCredential[] = [FORGE_CREDENTIAL]) => {
  const root = channelRoot();
  const channel = await openGitCredentialChannel(credentials, { root, random: systemRandom, files: nodeFileSystem, helper });
  onCleanup(() => channel.close());
  const env = channel.environment({ HOME: root, PATH: process.env['PATH'] ?? '/usr/bin:/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat' });
  return { channel, env, root };
};

const answered = (stdout: string) => expect.objectContaining({ code: 0, stdout });
const REFUSED = expect.objectContaining({ code: 1, stdout: '' });

describe('the credential channel of a git child, asked through the entry of the product in its helper mode', () => {
  it('answers the user name and the password of its origin once each, and nothing a second time', async () => {
    const { env } = await open();
    expect(await ask(env, "Username for 'https://forge.example': ")).toEqual(answered('x-access-token\n'));
    expect(await ask(env, "Password for 'https://x-access-token@forge.example': ")).toEqual(answered(`${CREDENTIAL}\n`));
    expect(await ask(env, "Password for 'https://x-access-token@forge.example': ")).toEqual(REFUSED);
  });

  it('answers nothing for the same host over http', async () => {
    const { env } = await open();
    expect(await ask(env, "Password for 'http://x-access-token@forge.example': ")).toEqual(REFUSED);
    expect(await ask(env, "Username for 'http://forge.example': ")).toEqual(REFUSED);
  });

  it('answers nothing for the same host on another port, and answers the default port written out', async () => {
    const { env } = await open();
    expect(await ask(env, "Password for 'https://x-access-token@forge.example:8443': ")).toEqual(REFUSED);
    expect(await ask(env, "Password for 'https://x-access-token@forge.example:443': ")).toEqual(answered(`${CREDENTIAL}\n`));
  });

  it('answers each path of one origin once', async () => {
    const { env } = await open();
    expect(await ask(env, "Password for 'https://x-access-token@forge.example/acme/widgets.git': ")).toEqual(answered(`${CREDENTIAL}\n`));
    expect(await ask(env, "Password for 'https://x-access-token@forge.example/acme/gadgets.git': ")).toEqual(answered(`${CREDENTIAL}\n`));
    expect(await ask(env, "Password for 'https://x-access-token@forge.example/acme/widgets.git': ")).toEqual(REFUSED);
    expect(await ask(env, "Password for 'https://x-access-token@forge.example/acme/gadgets.git': ")).toEqual(REFUSED);
  });

  it('answers each origin with its own credential', async () => {
    const other = { origin: 'https://other.example:8443', username: 'oauth2', password: 'another-fake-credential-for-tests' };
    const { env } = await open(ENTRY_AS_SCRIPT, [FORGE_CREDENTIAL, other]);
    expect(await ask(env, "Password for 'https://oauth2@other.example:8443/a/b.git': ")).toEqual(answered('another-fake-credential-for-tests\n'));
    expect(await ask(env, "Password for 'https://x-access-token@forge.example/a/b.git': ")).toEqual(answered(`${CREDENTIAL}\n`));
  });

  it('answers nothing for another host, and nothing to a caller without the nonce of the child', async () => {
    const { env } = await open();
    expect(await ask(env, "Password for 'https://x-access-token@elsewhere.example': ")).toEqual(REFUSED);
    expect(await ask({ ...env, MOMONGA_GIT_CREDENTIAL_NONCE: '0'.repeat(64) }, "Password for 'https://x-access-token@forge.example': ")).toEqual(REFUSED);
  });

  it('says on standard error why it gave nothing', async () => {
    const { env } = await open();
    const refused = await ask(env, "Password for 'https://x-access-token@elsewhere.example': ");
    expect(refused.stderr).toBe("momonga: no credential is held for the prompt Password for 'https://x-access-token@elsewhere.example': \n");
    const { MOMONGA_GIT_CREDENTIAL_SOCKET: _socket, ...withoutSocket } = env;
    expect((await ask(withoutSocket, "Password for 'https://x-access-token@forge.example': ")).stderr).toBe('momonga: the Git credential helper was started without MOMONGA_GIT_CREDENTIAL_SOCKET\n');
  });
});

describe('the program git starts for a prompt is the executable in its helper mode', () => {
  const recordingExecutable = (root: string): { file: string; record: string } => {
    const file = path.join(root, 'momonga-stand-in');
    const record = path.join(root, 'started-with');
    fs.writeFileSync(file, `#!/bin/sh\nfor argument in "$@"; do printf '%s\\n' "$argument"; done > '${record}'\nprintf 'from the executable\\n'\n`, { mode: 0o700 });
    return { file, record };
  };

  it('starts the single executable itself with the helper command, the name of the helper and the prompt, and no script', async () => {
    const standInRoot = channelRoot();
    const { file, record } = recordingExecutable(standInRoot);
    const { env } = await open({ execPath: file });
    const prompt = "Password for 'https://x-access-token@forge.example': ";
    expect(await ask(env, prompt)).toEqual(answered('from the executable\n'));
    expect(fs.readFileSync(record, 'utf8').split('\n')).toEqual([HELPER_COMMAND, 'git-askpass', prompt, '']);
  });

  it('starts the script build as the runtime with the entry script before the helper command', async () => {
    const { channel } = await open({ execPath: "/opt/it's node/bin/node", script: '/opt/momonga/main.js' });
    expect(fs.readFileSync(path.join(channel.directory, 'askpass'), 'utf8')).toBe(`#!/bin/sh\nexec '/opt/it'\\''s node/bin/node' '/opt/momonga/main.js' '${HELPER_COMMAND}' 'git-askpass' "$1"\n`);
  });

  it('writes no program of its own beside the one file git starts', async () => {
    const { channel } = await open();
    expect(fs.readdirSync(channel.directory).sort()).toEqual(['askpass', 's']);
  });
});

describe('what the channel gives the child and keeps from it', () => {
  it('turns the credential helpers of the user off, asks git to name the path in its prompt, and keeps the configuration the child already had', async () => {
    const { env } = await open();
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.pager',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'credential.useHttpPath',
      GIT_CONFIG_VALUE_2: 'true',
      GIT_TERMINAL_PROMPT: '0',
    });
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

  it('removes the credential from the output of the child with the redactor of the product', async () => {
    const { channel } = await open();
    expect(channel.redact(`fatal: ${CREDENTIAL} refused`)).toBe(`fatal: ${REDACTED_MARKER} refused`);
    const written = 'a+b/c fake credential';
    const encoded = await open(ENTRY_AS_SCRIPT, [{ ...FORGE_CREDENTIAL, password: written }]);
    expect(encoded.channel.redact(`fatal: https://x:${encodeURIComponent(written)}@forge.example refused`)).toBe(`fatal: https://x:${REDACTED_MARKER}@forge.example refused`);
  });

  it('refuses a place whose socket path the host cannot bind, names the path, and leaves nothing behind', async () => {
    const root = path.join(channelRoot(), 'd'.repeat(200));
    fs.mkdirSync(root);
    await expect(openGitCredentialChannel([FORGE_CREDENTIAL], { root, random: systemRandom, files: nodeFileSystem, helper: ENTRY_AS_SCRIPT })).rejects.toThrow(/Unix socket path .*must be shorter/s);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
