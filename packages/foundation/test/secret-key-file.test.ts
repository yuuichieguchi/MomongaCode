import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { secretKeyFile } from '@momonga/foundation';

const FOUNDATION_ENTRY = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts')).href;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-key-')));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
};

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const createInChild = (keyPath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const script = `const { secretKeyFile } = await import(${JSON.stringify(FOUNDATION_ENTRY)}); process.stdout.write(Buffer.from(secretKeyFile(${JSON.stringify(keyPath)})).toString('hex'));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`child exited ${code}: ${stderr}`))));
  });

describe('secretKeyFile', () => {
  it('creates a 32-byte 0600 regular file on first use and returns its bytes', () => {
    const keyPath = path.join(makeDir(), 'gateway.key');
    const key = secretKeyFile(keyPath);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.byteLength).toBe(32);
    const stat = fs.lstatSync(keyPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.uid).toBe(process.getuid?.());
    expect(hex(fs.readFileSync(keyPath))).toBe(hex(key));
    expect(hex(key)).not.toBe('00'.repeat(32));
  });

  it('honours a custom byte length', () => {
    const keyPath = path.join(makeDir(), 'other.key');
    expect(secretKeyFile(keyPath, { bytes: 16 }).byteLength).toBe(16);
    expect(fs.statSync(keyPath).size).toBe(16);
  });

  it('reuses the existing key instead of regenerating it', () => {
    const keyPath = path.join(makeDir(), 'gateway.key');
    const first = secretKeyFile(keyPath);
    const second = secretKeyFile(keyPath);
    expect(hex(second)).toBe(hex(first));
  });

  it('returns a key written by someone else verbatim', () => {
    const keyPath = path.join(makeDir(), 'gateway.key');
    const planted = Buffer.alloc(32, 7);
    fs.writeFileSync(keyPath, planted, { mode: 0o600 });
    expect(hex(secretKeyFile(keyPath))).toBe(planted.toString('hex'));
  });

  it('leaves no temporary files behind and sweeps stale ones', () => {
    const dir = makeDir();
    const keyPath = path.join(dir, 'gateway.key');
    fs.writeFileSync(`${keyPath}.deadbeef.tmp`, 'stale', { mode: 0o600 });
    secretKeyFile(keyPath);
    expect(fs.readdirSync(dir)).toEqual(['gateway.key']);
  });

  it('gives concurrent creators in separate processes the same key', { timeout: 30_000 }, async () => {
    const dir = makeDir();
    const keyPath = path.join(dir, 'gateway.key');
    const results = await Promise.all(Array.from({ length: 6 }, () => createInChild(keyPath)));
    expect(results[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(results).size).toBe(1);
    expect(fs.readFileSync(keyPath).toString('hex')).toBe(results[0]);
    expect(fs.readdirSync(dir)).toEqual(['gateway.key']);
  });

  it('refuses a key file of the wrong size, naming the path and the size', () => {
    const keyPath = path.join(makeDir(), 'gateway.key');
    fs.writeFileSync(keyPath, Buffer.alloc(16, 1), { mode: 0o600 });
    expect(() => secretKeyFile(keyPath)).toThrow(keyPath);
    expect(() => secretKeyFile(keyPath)).toThrow(/32/);
    expect(fs.readFileSync(keyPath).byteLength).toBe(16);
  });

  it('refuses a key file with a mode other than 0600', () => {
    const keyPath = path.join(makeDir(), 'gateway.key');
    fs.writeFileSync(keyPath, Buffer.alloc(32, 1), { mode: 0o600 });
    fs.chmodSync(keyPath, 0o644);
    expect(() => secretKeyFile(keyPath)).toThrow(keyPath);
    expect(() => secretKeyFile(keyPath)).toThrow(/0?600/);
  });

  it('refuses a symlink at the key path', () => {
    const dir = makeDir();
    const target = path.join(dir, 'real.key');
    fs.writeFileSync(target, Buffer.alloc(32, 1), { mode: 0o600 });
    const keyPath = path.join(dir, 'gateway.key');
    fs.symlinkSync(target, keyPath);
    expect(() => secretKeyFile(keyPath)).toThrow(keyPath);
  });

  it('refuses a directory at the key path', () => {
    const keyPath = path.join(makeDir(), 'gateway.key');
    fs.mkdirSync(keyPath, { mode: 0o700 });
    expect(() => secretKeyFile(keyPath)).toThrow(keyPath);
  });

  it('refuses to regenerate a missing key when dependent state exists', () => {
    const dir = makeDir();
    const keyPath = path.join(dir, 'gateway.key');
    const dbPath = path.join(dir, 'gateway.db');
    fs.writeFileSync(dbPath, '');
    expect(() => secretKeyFile(keyPath, { mustExist: true, dependentPath: dbPath })).toThrow(
      `gateway.db exists but gateway.key is missing at ${keyPath}; stored compaction items can no longer be verified. Move ${dbPath} aside to start fresh.`,
    );
    expect(fs.existsSync(keyPath)).toBe(false);
  });

  it('returns an existing key when mustExist is set', () => {
    const dir = makeDir();
    const keyPath = path.join(dir, 'gateway.key');
    const created = secretKeyFile(keyPath);
    expect(hex(secretKeyFile(keyPath, { mustExist: true, dependentPath: path.join(dir, 'gateway.db') }))).toBe(hex(created));
  });
});

const exitedPid = (): number => {
  const result = spawnSync('/usr/bin/true');
  if (result.pid === undefined) throw new Error('spawn failed');
  return result.pid;
};

describe('secretKeyFile stale temporaries with an existing key', () => {
  it('sweeps a stale tmp file of a dead pid even when the key already exists', () => {
    const dir = makeDir();
    const keyPath = path.join(dir, 'gateway.key');
    const created = secretKeyFile(keyPath);
    const stale = `${keyPath}.${exitedPid()}.0123456789ab.tmp`;
    fs.writeFileSync(stale, 'stale', { mode: 0o600 });
    expect(hex(secretKeyFile(keyPath))).toBe(hex(created));
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('keeps a tmp file that belongs to a live pid', () => {
    const dir = makeDir();
    const keyPath = path.join(dir, 'gateway.key');
    secretKeyFile(keyPath);
    const live = `${keyPath}.${process.pid}.0123456789ab.tmp`;
    const stale = `${keyPath}.${exitedPid()}.ba9876543210.tmp`;
    fs.writeFileSync(live, 'in progress', { mode: 0o600 });
    fs.writeFileSync(stale, 'stale', { mode: 0o600 });
    secretKeyFile(keyPath);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
  });
});
