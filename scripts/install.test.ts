import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nodeCommandRunner, verifyReleaseSignature } from '@momonga/foundation';
import { repoRoot } from './bundle.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { HAS_POSIX_SHELL } from './support/host.ts';

const INSTALL_SCRIPT = `${repoRoot}scripts/install.sh`;
const ASSET = 'momonga-darwin-arm64';
const GOOD_BINARY = Buffer.from('#!/bin/sh\necho momonga-installed\n');
const TAMPERED_BINARY = Buffer.from('#!/bin/sh\necho momonga-tampered\n');

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const SIGNATURE_NAMESPACE = 'momonga-release';

const generateKey = (directory: string, name: string): { privateKey: string; publicKey: string } => {
  const privateKey = path.join(directory, name);
  execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', privateKey]);
  return { privateKey, publicKey: fs.readFileSync(`${privateKey}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ') };
};

const signWith = (privateKey: string, contents: Buffer, directory: string): Buffer => {
  const file = path.join(directory, `sums-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(file, contents);
  execFileSync('/usr/bin/ssh-keygen', ['-Y', 'sign', '-q', '-f', privateKey, '-n', SIGNATURE_NAMESPACE, file]);
  return fs.readFileSync(`${file}.sig`);
};

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

describe.skipIf(!HAS_POSIX_SHELL)('install.sh', () => {
  let root = '';
  let server: http.Server;
  let served: Served = {};
  let prefix = '';
  let baseUrl = '';
  let release = { privateKey: '', publicKey: '' };
  let attacker = { privateKey: '', publicKey: '' };

  const target = (): string => path.join(prefix, 'bin', 'momonga');
  const unameStub = (os: string, machine: string): string => {
    const stubs = fs.mkdtempSync(path.join(root, 'uname-'));
    fs.writeFileSync(path.join(stubs, 'uname'), `#!/bin/sh\nif [ "$1" = "-m" ]; then echo ${machine}; else echo ${os}; fi\n`, { mode: 0o755 });
    return stubs;
  };
  const baseEnv = (): NodeJS.ProcessEnv => ({
    PATH: `${unameStub('Darwin', 'arm64')}:/usr/bin:/bin`,
    HOME: root,
    MOMONGA_INSTALL_PREFIX: prefix,
    MOMONGA_RELEASE_BASE_URL: baseUrl,
    MOMONGA_RELEASE_PUBLIC_KEY: release.publicKey,
  });
  const signedSums = (sums: string, key = release.privateKey): Served => {
    const bytes = Buffer.from(sums);
    return { '/SHA256SUMS': bytes, '/SHA256SUMS.sig': signWith(key, bytes, root) };
  };
  const serveRelease = (binary: Buffer, sumsFor: Buffer): void => {
    served = { [`/${ASSET}`]: binary, ...signedSums(`${sha256(sumsFor)}  ${ASSET}\n`) };
  };

  beforeAll(async () => {
    root = createTempRoot();
    release = generateKey(root, 'release_key');
    attacker = generateKey(root, 'attacker_key');
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
    served = { [`/${ASSET}`]: GOOD_BINARY, ...signedSums(`${sha256(GOOD_BINARY)}  other-file\n`) };
    const outcome = await runInstall(baseEnv());
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toBe(`install.sh: SHA256SUMS has no valid entry for ${ASSET}\n`);
    expect(fs.readdirSync(path.join(prefix, 'bin'))).toEqual([]);
  });

  it('fails when the artifact is not published', async () => {
    served = signedSums(`${sha256(GOOD_BINARY)}  ${ASSET}\n`);
    const outcome = await runInstall(baseEnv());
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('404');
    expect(fs.readdirSync(path.join(prefix, 'bin'))).toEqual([]);
  });

  it('refuses an unsupported operating system', async () => {
    const stubs = path.join(root, 'stubs');
    fs.mkdirSync(stubs, { recursive: true });
    fs.writeFileSync(path.join(stubs, 'uname'), '#!/bin/sh\necho FreeBSD\n', { mode: 0o755 });
    serveRelease(GOOD_BINARY, GOOD_BINARY);
    const outcome = await runInstall({ ...baseEnv(), PATH: `${stubs}:/usr/bin:/bin` });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toBe('install.sh: unsupported OS FreeBSD: only macOS and Linux are supported; use install.ps1 on Windows\n');
    expect(fs.existsSync(path.join(prefix, 'bin'))).toBe(false);
  });

  it.each([
    ['x86_64', 'momonga-linux-x64'],
    ['aarch64', 'momonga-linux-arm64'],
  ])('installs the %s Linux artifact as %s', async (machine, asset) => {
    served = { [`/${asset}`]: GOOD_BINARY, ...signedSums(`${sha256(GOOD_BINARY)}  ${asset}\n`) };
    const outcome = await runInstall({ ...baseEnv(), PATH: `${unameStub('Linux', machine)}:/usr/bin:/bin` });
    expect(outcome.code).toBe(0);
    expect(fs.readFileSync(target())).toEqual(GOOD_BINARY);
  });

  it('refuses an unsupported Linux architecture', async () => {
    const outcome = await runInstall({ ...baseEnv(), PATH: `${unameStub('Linux', 'riscv64')}:/usr/bin:/bin` });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toBe('install.sh: unsupported architecture riscv64: only x86_64 and aarch64 are supported on Linux\n');
  });

  it('requires a repository or a base url', async () => {
    const env = baseEnv();
    delete env['MOMONGA_RELEASE_BASE_URL'];
    const outcome = await runInstall(env);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toBe('install.sh: set MOMONGA_REPO=<owner>/<repo> or MOMONGA_RELEASE_BASE_URL\n');
  });

  const EMBEDDED_REPO_DECLARATION = 'readonly EMBEDDED_RELEASE_REPO=""';

  const installerWithRepo = (repo: string): string => {
    const source = fs.readFileSync(INSTALL_SCRIPT, 'utf8');
    expect(source).toContain(EMBEDDED_REPO_DECLARATION);
    const directory = fs.mkdtempSync(path.join(root, 'embedded-'));
    const script = path.join(directory, 'install.sh');
    fs.writeFileSync(script, source.replace(EMBEDDED_REPO_DECLARATION, `readonly EMBEDDED_RELEASE_REPO="${repo}"`));
    return script;
  };

  const fetchedUrls = async (script: string, extra: NodeJS.ProcessEnv): Promise<{ urls: string[]; outcome: Outcome }> => {
    const stubs = unameStub('Darwin', 'arm64');
    const log = path.join(stubs, 'curl.log');
    fs.writeFileSync(path.join(stubs, 'curl'), `#!/bin/sh\nfor last; do :; done\nprintf '%s\\n' "$last" >> "${log}"\nexit 22\n`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...baseEnv(), PATH: `${stubs}:/usr/bin:/bin`, ...extra };
    delete env['MOMONGA_RELEASE_BASE_URL'];
    const outcome = await new Promise<Outcome>((resolve, reject) => {
      execFile('/bin/bash', [script], { env }, (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr });
        if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr });
        reject(error);
      });
    });
    const urls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0) : [];
    return { urls, outcome };
  };

  it('declares an empty embedded repository right after the embedded release public key', () => {
    const lines = fs.readFileSync(INSTALL_SCRIPT, 'utf8').split('\n');
    const keyLine = lines.indexOf('readonly EMBEDDED_RELEASE_PUBLIC_KEY=""');
    expect(keyLine).toBeGreaterThanOrEqual(0);
    expect(lines[keyLine + 1]).toBe(EMBEDDED_REPO_DECLARATION);
  });

  it('downloads the latest release of the embedded repository when MOMONGA_REPO is not set', async () => {
    const { urls } = await fetchedUrls(installerWithRepo('embedded-owner/embedded-repo'), {});
    expect(urls[0]).toBe('https://github.com/embedded-owner/embedded-repo/releases/latest/download/SHA256SUMS');
  });

  it('downloads the requested version of the embedded repository when MOMONGA_VERSION is set', async () => {
    const { urls } = await fetchedUrls(installerWithRepo('embedded-owner/embedded-repo'), { MOMONGA_VERSION: '1.2.3' });
    expect(urls[0]).toBe('https://github.com/embedded-owner/embedded-repo/releases/download/v1.2.3/SHA256SUMS');
  });

  it('lets MOMONGA_REPO override the embedded repository', async () => {
    const { urls } = await fetchedUrls(installerWithRepo('embedded-owner/embedded-repo'), { MOMONGA_REPO: 'override-owner/override-repo' });
    expect(urls[0]).toBe('https://github.com/override-owner/override-repo/releases/latest/download/SHA256SUMS');
  });

  it('refuses a release whose checksums are signed by another key, even when the binary matches them', async () => {
    served = { [`/${ASSET}`]: TAMPERED_BINARY, ...signedSums(`${sha256(TAMPERED_BINARY)}  ${ASSET}\n`, attacker.privateKey) };
    const outcome = await runInstall(baseEnv());
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toBe('install.sh: SHA256SUMS is not signed by the pinned release key; nothing was installed\n');
    expect(fs.readdirSync(path.join(prefix, 'bin'))).toEqual([]);
  });

  it('refuses checksums altered after they were signed', async () => {
    const genuine = signedSums(`${sha256(GOOD_BINARY)}  ${ASSET}\n`);
    served = { [`/${ASSET}`]: TAMPERED_BINARY, '/SHA256SUMS': Buffer.from(`${sha256(TAMPERED_BINARY)}  ${ASSET}\n`), '/SHA256SUMS.sig': genuine['/SHA256SUMS.sig'] as Buffer };
    const outcome = await runInstall(baseEnv());
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('is not signed by the pinned release key');
    expect(fs.readdirSync(path.join(prefix, 'bin'))).toEqual([]);
  });

  it('refuses a release that publishes no signature', async () => {
    served = { [`/${ASSET}`]: GOOD_BINARY, '/SHA256SUMS': Buffer.from(`${sha256(GOOD_BINARY)}  ${ASSET}\n`) };
    const outcome = await runInstall(baseEnv());
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('404');
    expect(fs.readdirSync(path.join(prefix, 'bin'))).toEqual([]);
  });

  it('reaches the same verdict as the verifier the updater and release.sh use on a genuine, a foreign-key and an altered listing', async () => {
    const genuineSums = Buffer.from(`${sha256(GOOD_BINARY)}  ${ASSET}\n`);
    const alteredSums = Buffer.from(`${sha256(TAMPERED_BINARY)}  ${ASSET}\n`);
    const genuineSignature = signWith(release.privateKey, genuineSums, root);
    const cases = [
      { label: 'genuine', binary: GOOD_BINARY, sums: genuineSums, signature: genuineSignature, accepted: true },
      { label: 'foreign key', binary: GOOD_BINARY, sums: genuineSums, signature: signWith(attacker.privateKey, genuineSums, root), accepted: false },
      { label: 'altered listing', binary: TAMPERED_BINARY, sums: alteredSums, signature: genuineSignature, accepted: false },
    ];
    let placed = 0;
    for (const { label, binary, sums, signature, accepted } of cases) {
      const verdict = await verifyReleaseSignature({
        run: nodeCommandRunner,
        env: { PATH: '/usr/bin:/bin' },
        place: async (content) => {
          const file = path.join(root, `placed-${(placed += 1)}`);
          fs.writeFileSync(file, content);
          return { path: file, remove: async () => fs.rmSync(file) };
        },
        publicKey: release.publicKey,
        checksums: sums.toString('utf8'),
        signature: signature.toString('utf8'),
      });
      served = { [`/${ASSET}`]: binary, '/SHA256SUMS': sums, '/SHA256SUMS.sig': signature };
      const outcome = await runInstall(baseEnv());
      expect({ label, updater: verdict.kind === 'valid', installer: outcome.code === 0 }).toEqual({ label, updater: accepted, installer: accepted });
      fs.rmSync(path.join(prefix, 'bin'), { recursive: true, force: true });
    }
  });

  it('refuses to run without a pinned release key', async () => {
    serveRelease(GOOD_BINARY, GOOD_BINARY);
    const env = baseEnv();
    delete env['MOMONGA_RELEASE_PUBLIC_KEY'];
    const outcome = await runInstall(env);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('this installer pins no release signing key');
    expect(outcome.stderr).toContain('set MOMONGA_RELEASE_PUBLIC_KEY to the ssh public key line the maintainers publish');
    expect(fs.existsSync(path.join(prefix, 'bin'))).toBe(false);
  });

  it.each(['http://example.com/releases', 'http://127.0.0.1.evil.example/releases', 'http://127.0.0.1:80@evil.example/releases', 'ftp://example.com/releases'])('refuses the release location %s', async (location) => {
    serveRelease(GOOD_BINARY, GOOD_BINARY);
    const outcome = await runInstall({ ...baseEnv(), MOMONGA_RELEASE_BASE_URL: location });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toBe(`install.sh: the release location must be https (plain http is accepted only on the loopback interface), got ${location}\n`);
    expect(fs.existsSync(path.join(prefix, 'bin'))).toBe(false);
  });
});
