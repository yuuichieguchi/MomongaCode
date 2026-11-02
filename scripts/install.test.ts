import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

const INSTALL_SCRIPT = `${repoRoot}scripts/install.sh`;
const ASSET = 'momonga-darwin-arm64';
const GOOD_BINARY = Buffer.from('#!/bin/sh\necho momonga-installed\n');
const TAMPERED_BINARY = Buffer.from('#!/bin/sh\necho momonga-tampered\n');

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

type Served = Record<string, Buffer>;

const listen = async (files: () => Served): Promise<http.Server> => {
  const server = http.createServer((request, response) => {
    const body = files()[request.url ?? ''];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
};

type Outcome = { readonly code: number; readonly stdout: string; readonly stderr: string };

const runInstall = (env: NodeJS.ProcessEnv): Promise<Outcome> =>
  new Promise((resolve, reject) => {
    execFile('/bin/bash', [INSTALL_SCRIPT], { env }, (error, stdout, stderr) => {
      if (error === null) return resolve({ code: 0, stdout, stderr });
      if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr });
      reject(error);
    });
  });

describe('install.sh', () => {
  let root = '';
  let server: http.Server;
  let served: Served = {};
  let prefix = '';
  let baseUrl = '';

  const target = (): string => path.join(prefix, 'bin', 'momonga');
  const baseEnv = (): NodeJS.ProcessEnv => ({
    PATH: '/usr/bin:/bin',
    HOME: root,
    MOMONGA_INSTALL_PREFIX: prefix,
    MOMONGA_RELEASE_BASE_URL: baseUrl,
  });
  const serveRelease = (binary: Buffer, sumsFor: Buffer): void => {
    served = { [`/${ASSET}`]: binary, '/SHA256SUMS': Buffer.from(`${sha256(sumsFor)}  ${ASSET}\n`) };
  };

  beforeAll(async () => {
    root = createTempRoot();
    server = await listen(() => served);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    removeTempRoot(root);
  });

  beforeEach(() => {
    prefix = fs.mkdtempSync(path.join(root, 'prefix-'));
    served = {};
  });

  afterEach(() => {
    fs.rmSync(prefix, { recursive: true, force: true });
  });

  it('installs a verified artifact as an executable', async () => {
    serveRelease(GOOD_BINARY, GOOD_BINARY);
    const outcome = await runInstall(baseEnv());
    expect(outcome).toEqual({ code: 0, stdout: `installed momonga to ${target()}\n`, stderr: '' });
    expect(fs.readFileSync(target())).toEqual(GOOD_BINARY);
    expect(fs.statSync(target()).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(path.join(prefix, 'bin'))).toEqual(['momonga']);
    const executed = await new Promise<string>((resolve, reject) => {
      execFile(target(), (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
    expect(executed).toBe('momonga-installed\n');
  });

  it('replaces an existing install', async () => {
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.writeFileSync(target(), 'old');
    serveRelease(GOOD_BINARY, GOOD_BINARY);
    expect((await runInstall(baseEnv())).code).toBe(0);
    expect(fs.readFileSync(target())).toEqual(GOOD_BINARY);
  });

  it('refuses a tampered artifact and leaves nothing behind', async () => {
    serveRelease(TAMPERED_BINARY, GOOD_BINARY);
    const outcome = await runInstall(baseEnv());
    expect(outcome.code).toBe(1);
    expect(outcome.stdout).toBe('');
    expect(outcome.stderr).toBe(
      `install.sh: sha256 mismatch for ${ASSET}: expected ${sha256(GOOD_BINARY)}, got ${sha256(TAMPERED_BINARY)}; nothing was installed\n`,
    );
    expect(fs.existsSync(target())).toBe(false);
    expect(fs.readdirSync(path.join(prefix, 'bin'))).toEqual([]);
  });

  it('keeps the existing install when the artifact is tampered', async () => {
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.writeFileSync(target(), 'old');
    serveRelease(TAMPERED_BINARY, GOOD_BINARY);
    expect((await runInstall(baseEnv())).code).toBe(1);
    expect(fs.readFileSync(target(), 'utf8')).toBe('old');
    expect(fs.readdirSync(path.join(prefix, 'bin'))).toEqual(['momonga']);
  });

  it('refuses a checksum file without an entry for the artifact', async () => {
    served = { [`/${ASSET}`]: GOOD_BINARY, '/SHA256SUMS': Buffer.from(`${sha256(GOOD_BINARY)}  other-file\n`) };
    const outcome = await runInstall(baseEnv());
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toBe(`install.sh: SHA256SUMS has no valid entry for ${ASSET}\n`);
    expect(fs.readdirSync(path.join(prefix, 'bin'))).toEqual([]);
  });

  it('fails when the artifact is not published', async () => {
    served = { '/SHA256SUMS': Buffer.from(`${sha256(GOOD_BINARY)}  ${ASSET}\n`) };
    const outcome = await runInstall(baseEnv());
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('404');
    expect(fs.readdirSync(path.join(prefix, 'bin'))).toEqual([]);
  });

  it('refuses an unsupported platform', async () => {
    const stubs = path.join(root, 'stubs');
    fs.mkdirSync(stubs, { recursive: true });
    fs.writeFileSync(path.join(stubs, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 });
    serveRelease(GOOD_BINARY, GOOD_BINARY);
    const outcome = await runInstall({ ...baseEnv(), PATH: `${stubs}:/usr/bin:/bin` });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toBe('install.sh: unsupported OS Linux: only macOS is supported\n');
    expect(fs.existsSync(path.join(prefix, 'bin'))).toBe(false);
  });

  it('requires a repository or a base url', async () => {
    const env = baseEnv();
    delete env['MOMONGA_RELEASE_BASE_URL'];
    const outcome = await runInstall(env);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toBe('install.sh: set MOMONGA_REPO=<owner>/<repo> or MOMONGA_RELEASE_BASE_URL\n');
  });
});
