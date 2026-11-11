import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  LOCK_FD,
  LOCK_FD_ENV,
  LOCK_NONCE_ENV,
  LockAdoptionError,
  ProcessLockHeldError,
  UnadoptedEnv,
  acquireProcessLock,
  claimLockForChild,
  createKernelLockMechanism,
  hostKernelLock,
  inspectProcessLock,
} from '@momonga/foundation';
import type { InheritedLockRequest, KernelLockMechanism } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeKernelLock, registerCleanup, spawnTracked, withTempDir, createFakeRandom } from '@momonga/testkit';
import type { CleanupContext, TrackedChild } from '@momonga/testkit';
import { ADOPTER_FIXTURE, exitOf, firstLine, spawnFixture } from './support/lock-processes.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const INHERITABLE = hostKernelLock().claimInheritable !== undefined;

const claimed = (lockPath: string) => {
  const claim = claimLockForChild(lockPath);
  if (claim.kind !== 'claimed') throw new Error(`expected a claim, got ${claim.kind}`);
  return claim.handoff;
};

const spawnAdopter = (context: CleanupContext, lockPath: string, descriptor: number, env: Record<string, string>): TrackedChild =>
  spawnFixture(context, ADOPTER_FIXTURE, [lockPath], { stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', descriptor], env: { ...process.env, ...env } });

describe('claimLockForChild', () => {
  it('reports a mechanism without an inheritable descriptor as unsupported', () => {
    expect(claimLockForChild('/unused', { mechanism: createKernelLockMechanism('linux') })).toEqual({ kind: 'unsupported' });
    expect(claimLockForChild('/unused', { mechanism: createKernelLockMechanism('win32') })).toEqual({ kind: 'unsupported' });
  });
});

describe('the hand-off goes through the lock mechanism on both sides', () => {
  it('takes the hand-off nonce from the injected random source', (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const kernel = createFakeKernelLock({ inheritable: true });
    const claim = claimLockForChild(lockPath, { mechanism: kernel, random: { ...createFakeRandom(1), hex: () => 'fixed-nonce' } });
    if (claim.kind !== 'claimed') throw new Error(`expected a claim, got ${claim.kind}`);
    expect(claim.handoff.env[LOCK_NONCE_ENV]).toBe('fixed-nonce');
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('handoff:fixed-nonce');
    claim.handoff.closeParentCopy();
  });

  it('asks the mechanism to adopt the descriptor, naming the record it expects and the record it leaves', () => {
    const requests: InheritedLockRequest[] = [];
    const mechanism: KernelLockMechanism = {
      ...createFakeKernelLock({ inheritable: true }),
      adoptInherited: (request) => {
        requests.push(request);
        return { descriptor: request.descriptor, writeHolder: () => undefined, release: () => undefined, dispose: () => undefined };
      },
    };
    new UnadoptedEnv({ [LOCK_FD_ENV]: '5', [LOCK_NONCE_ENV]: 'abc' }).adopt('/run/runtime.lock', { mechanism }).release();
    expect(requests).toEqual([{ lockPath: '/run/runtime.lock', descriptor: 5, expectedHolder: 'handoff:abc', newHolder: String(process.pid) }]);
  });

  it('refuses a hand-off to a mechanism whose locks cannot be inherited', () => {
    const mechanism = createKernelLockMechanism('linux');
    expect(() => new UnadoptedEnv({ [LOCK_FD_ENV]: '5', [LOCK_NONCE_ENV]: 'abc' }).adopt('/unused', { mechanism })).toThrow(LockAdoptionError);
  });
});

describe.skipIf(!INHERITABLE)('lock hand-off to a child with real processes', () => {
  it('puts the claim in the child: the parent copy is closed after spawn and the child adopts, records its pid and scrubs its env', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const handoff = claimed(lockPath);
    expect(handoff.slot).toBe(LOCK_FD);
    expect(Object.keys(handoff.env).sort()).toEqual([LOCK_FD_ENV, LOCK_NONCE_ENV]);
    const child = spawnAdopter(context, lockPath, handoff.descriptor, handoff.env);
    handoff.closeParentCopy();
    expect(await firstLine(child)).toBe('adopted []');
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'held', pid: child.pid });
    const failure = await acquireProcessLock(lockPath).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProcessLockHeldError);
    expect((failure as ProcessLockHeldError).holderPid).toBe(child.pid);
    child.kill('SIGKILL');
    expect(await exitOf(child)).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'free' });
  });

  it('keeps the lock held for the child alone: nobody can claim it while the parent copy is open, and the parent copy does not outlive the child', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const handoff = claimed(lockPath);
    expect(claimLockForChild(lockPath)).toEqual({ kind: 'held', holderPid: undefined });
    const child = spawnAdopter(context, lockPath, handoff.descriptor, handoff.env);
    handoff.closeParentCopy();
    await firstLine(child);
    child.kill('SIGKILL');
    await exitOf(child);
    const next = claimLockForChild(lockPath);
    expect(next.kind).toBe('claimed');
    if (next.kind === 'claimed') next.handoff.closeParentCopy();
  });

  it('frees the lock when the child dies before adopting it, because the parent copy is already closed', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const handoff = claimed(lockPath);
    const child = spawnTracked(context, process.execPath, ['-e', 'setInterval(() => undefined, 60000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ignore', 'ignore', handoff.descriptor] });
    handoff.closeParentCopy();
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'unreadable' });
    child.kill('SIGKILL');
    await exitOf(child);
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'free' });
  });

  it('releases the claim when the parent gives up before any child exists', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    claimed(lockPath).closeParentCopy();
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'free' });
  });

  it('reports the holder of a lock that is already held', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const lock = await acquireProcessLock(lockPath);
    registerCleanup(context, () => lock.release());
    expect(claimLockForChild(lockPath)).toEqual({ kind: 'held', holderPid: process.pid });
  });

  it('refuses to adopt when the nonce in the environment is not the one written into the lock file', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const handoff = claimed(lockPath);
    const child = spawnAdopter(context, lockPath, handoff.descriptor, { ...handoff.env, [LOCK_NONCE_ENV]: '0'.repeat(32) });
    handoff.closeParentCopy();
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const { code } = await exitOf(child);
    expect(code).not.toBe(0);
    expect(stderr).toContain('does not carry the hand-off nonce');
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'free' });
  });

  it('refuses to adopt a descriptor that is not the lock file', async (context) => {
    const dir = withTempDir(context);
    const lockPath = path.join(dir, 'runtime.lock');
    const handoff = claimed(lockPath);
    const other = path.join(dir, 'other');
    fs.writeFileSync(other, '');
    const otherFd = fs.openSync(other, 'r');
    registerCleanup(context, () => fs.closeSync(otherFd));
    const child = spawnAdopter(context, lockPath, otherFd, handoff.env);
    handoff.closeParentCopy();
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const { code } = await exitOf(child);
    expect(code).not.toBe(0);
    expect(stderr).toContain(`is not ${lockPath}`);
  });

  it('refuses to adopt when the named descriptor is not open', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const handoff = claimed(lockPath);
    const child = spawnFixture(context, ADOPTER_FIXTURE, [lockPath], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...handoff.env, [LOCK_FD_ENV]: '987' } });
    handoff.closeParentCopy();
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const { code } = await exitOf(child);
    expect(code).not.toBe(0);
    expect(stderr).toContain('is not open');
  });
});

describe('UnadoptedEnv', () => {
  it('is not a handed-off environment without the variables, and passes the environment through', () => {
    const unadopted = new UnadoptedEnv({ HOME: '/home/a' });
    expect(unadopted.handedOff).toBe(false);
    expect(unadopted.withoutLockVariables()).toEqual({ HOME: '/home/a' });
  });

  it('strips both variables and hides the environment from enumeration and serialisation', () => {
    const unadopted = new UnadoptedEnv({ HOME: '/home/a', [LOCK_FD_ENV]: '5', [LOCK_NONCE_ENV]: 'abc' });
    expect(unadopted.handedOff).toBe(true);
    expect(unadopted.withoutLockVariables()).toEqual({ HOME: '/home/a' });
    expect(Object.keys(unadopted)).toEqual([]);
    expect(JSON.stringify(unadopted)).toBe('{}');
    expect({ ...unadopted }).toEqual({});
  });

  it('refuses a half-set hand-off and a descriptor that is not a number', () => {
    expect(() => new UnadoptedEnv({ [LOCK_FD_ENV]: '5' }).adopt('/unused')).toThrow('must be set together');
    expect(() => new UnadoptedEnv({ [LOCK_FD_ENV]: 'five', [LOCK_NONCE_ENV]: 'abc' }).adopt('/unused')).toThrow('not a descriptor number');
    expect(() => new UnadoptedEnv({ [LOCK_FD_ENV]: '0', [LOCK_NONCE_ENV]: 'abc' }).adopt('/unused')).toThrow('not a descriptor number');
  });
});
