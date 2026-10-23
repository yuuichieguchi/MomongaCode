import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireProcessLock, isProcessAlive } from '@momonga/foundation';

const tempDirs: string[] = [];
const children: number[] = [];

afterEach(() => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-lock-'));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
};

const deadPid = async (): Promise<number> => {
  const child = spawn('/usr/bin/true', [], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('spawn failed');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return pid;
};

const livePid = (): number => {
  const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  if (child.pid === undefined) throw new Error('spawn failed');
  children.push(child.pid);
  return child.pid;
};

describe('acquireProcessLock', () => {
  it('creates the lock file holding the current pid', async () => {
    const lockPath = path.join(makeDir(), 'gateway.lock');
    const lock = await acquireProcessLock(lockPath);
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
    await lock.release();
  });

  it('removes the lock file on release', async () => {
    const lockPath = path.join(makeDir(), 'gateway.lock');
    const lock = await acquireProcessLock(lockPath);
    await lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('can be acquired again after release', async () => {
    const lockPath = path.join(makeDir(), 'gateway.lock');
    await (await acquireProcessLock(lockPath)).release();
    const again = await acquireProcessLock(lockPath);
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
    await again.release();
  });

  it('throws without waiting when a live process holds the lock, naming its pid', async () => {
    const lockPath = path.join(makeDir(), 'gateway.lock');
    const holder = livePid();
    fs.writeFileSync(lockPath, String(holder), { mode: 0o600 });
    const started = Date.now();
    await expect(async () => acquireProcessLock(lockPath)).rejects.toThrow(String(holder));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(String(holder));
  });

  it('refuses a second acquisition by the same live process', async () => {
    const lockPath = path.join(makeDir(), 'runtime.lock');
    const lock = await acquireProcessLock(lockPath);
    await expect(async () => acquireProcessLock(lockPath)).rejects.toThrow(String(process.pid));
    await lock.release();
  });

  it('takes over a lock left by a dead process', async () => {
    const lockPath = path.join(makeDir(), 'gateway.lock');
    const dead = await deadPid();
    fs.writeFileSync(lockPath, String(dead), { mode: 0o600 });
    const lock = await acquireProcessLock(lockPath);
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
    await lock.release();
  });

  it('does not remove a lock that another process has since taken', async () => {
    const lockPath = path.join(makeDir(), 'gateway.lock');
    const lock = await acquireProcessLock(lockPath);
    const other = livePid();
    fs.rmSync(lockPath);
    fs.writeFileSync(lockPath, String(other), { mode: 0o600 });
    await lock.release();
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(String(other));
  });
});

describe('isProcessAlive', () => {
  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('reports a running child as alive', () => {
    expect(isProcessAlive(livePid())).toBe(true);
  });

  it('reports an exited process as dead', async () => {
    expect(isProcessAlive(await deadPid())).toBe(false);
  });

  it('treats EPERM as alive', () => {
    expect(isProcessAlive(1)).toBe(true);
  });

  it('rethrows errors other than ESRCH and EPERM', () => {
    expect(() => isProcessAlive(Number.NaN)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });
});
