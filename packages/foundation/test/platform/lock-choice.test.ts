import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as foundation from '../../src/index.ts';
import { resolveKernelLock } from '../../src/platform/kernel-lock.ts';
import { LockProofFailedError, createLockCapability, resolveLayoutLocks } from '../../src/platform/lock-capability.ts';
import { ensureMomongaDirs, momongaLayout } from '../../src/momonga-paths.ts';
import { hostInspectorPorts } from '../../src/platform/process-inspector.ts';
import { makeShortHomeDirectory, makeTemporaryDirectory } from '../support/temporary-directory.ts';
import { lockIgnoringOps } from '../support/probe-fakes.ts';
import { systemTempRoot } from '@momonga/testkit';

const PLATFORM_SOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'platform');

const sourceOf = (name: string): string => fs.readFileSync(path.join(PLATFORM_SOURCES, name), 'utf8');

const realUid = (): number => {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('this test needs a host with user ids');
  return uid;
};

const directories = (proofMode: number) => {
  const root = makeTemporaryDirectory();
  const proofDir = path.join(root, 'run', 'lock-proof');
  const lockDir = path.join(root, 'run', 'call-locks');
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(proofDir, { mode: proofMode });
  fs.chmodSync(proofDir, proofMode);
  return { root, proofDir, lockDir };
};

describe('one proof decides the lock of a directory', () => {
  it('the foundation offers no lock chosen by a platform name and no proof directory of its own', () => {
    const exported = Object.keys(foundation);
    expect(exported.filter((name) => ['hostKernelLock', 'createKernelLockMechanism', 'hostLockCapability', 'defaultProcessInspector'].includes(name))).toEqual([]);
    expect(fs.existsSync(path.join(PLATFORM_SOURCES, 'host-kernel-lock.ts'))).toBe(false);
  });

  it('the proof module reads no temporary directory and no platform name', () => {
    const text = sourceOf('lock-capability.ts');
    expect(text).not.toMatch(/node:os|tmpdir|process\.platform/);
  });

  it('the locks of a layout are proved in <run>/lock-proof, which lies under the home and not under the temporary directory', async () => {
    const home = makeShortHomeDirectory();
    const paths = momongaLayout(home, process.platform, {});
    await ensureMomongaDirs(paths);
    const before = fs.readdirSync(systemTempRoot()).filter((name) => name.startsWith('momonga-lock-proof'));
    const locks = resolveLayoutLocks(paths);
    expect(paths.lockProof).toBe(path.join(paths.run, 'lock-proof'));
    expect(locks.mechanism.name).toBe((await locks.capability.of(paths.callLocks)) === 'proved' ? 'file-lock' : 'sqlite-lock');
    expect(fs.readdirSync(paths.lockProof)).toEqual([]);
    expect(fs.readdirSync(systemTempRoot()).filter((name) => name.startsWith('momonga-lock-proof'))).toEqual(before);
  });

  it('gives each lock directory the mechanism its own proof decides, not the mechanism of the call locks', async () => {
    const home = makeShortHomeDirectory();
    const paths = momongaLayout(home, process.platform, {});
    await ensureMomongaDirs(paths);
    const locks = resolveLayoutLocks(paths);
    const sessions = paths.tmp.sessions;
    expect(locks.mechanismOf(paths.callLocks).name).toBe(locks.mechanism.name);
    expect(locks.mechanismOf(sessions).name).toBe((await locks.capability.of(sessions)) === 'proved' ? 'file-lock' : 'sqlite-lock');
  });

  it.runIf(process.platform === 'darwin')('a layout on a filesystem that enforces BSD locks gets the file lock', async () => {
    const home = makeShortHomeDirectory();
    const paths = momongaLayout(home, process.platform, {});
    await ensureMomongaDirs(paths);
    expect(resolveLayoutLocks(paths).mechanism.name).toBe('file-lock');
  });

  it('a proof directory owned by another account is unmeasured and gives the SQLite lock', async () => {
    const { proofDir, lockDir } = directories(0o700);
    const capability = createLockCapability({ proofDir, uid: () => realUid() + 1 });
    expect(await capability.of(lockDir)).toBe('unmeasured');
    expect(resolveKernelLock(lockDir, { capability }).name).toBe('sqlite-lock');
    expect(fs.readdirSync(proofDir)).toEqual([]);
  });

  it('a proof directory other accounts can enter is unmeasured and no proof file is created in it', async () => {
    const { proofDir, lockDir } = directories(0o755);
    const capability = createLockCapability({ proofDir });
    expect(await capability.of(lockDir)).toBe('unmeasured');
    expect(resolveKernelLock(lockDir, { capability }).name).toBe('sqlite-lock');
    expect(fs.readdirSync(proofDir)).toEqual([]);
  });

  it('a proof directory that is a link is unmeasured', async () => {
    const { root, proofDir, lockDir } = directories(0o700);
    const link = path.join(root, 'run', 'lock-proof-link');
    fs.symlinkSync(proofDir, link);
    expect(await createLockCapability({ proofDir: link }).of(lockDir)).toBe('unmeasured');
  });

  it('a private proof directory of this account is measured', async () => {
    const { proofDir, lockDir } = directories(0o700);
    expect(await createLockCapability({ proofDir, ops: lockIgnoringOps() }).of(lockDir)).toBe('unenforced');
  });

  it('a proof that fails gives no lock: the failure is reported with the directory and its cause', async () => {
    const { proofDir, lockDir } = directories(0o700);
    const ops = {
      ...lockIgnoringOps(),
      open: (): number => {
        throw Object.assign(new Error('EMFILE: injected'), { code: 'EMFILE' });
      },
    };
    const capability = createLockCapability({ proofDir, ops });
    expect(await capability.of(lockDir)).toBe('unmeasured');
    expect(() => resolveKernelLock(lockDir, { capability })).toThrow(LockProofFailedError);
    expect(() => resolveKernelLock(lockDir, { capability })).toThrow(`Whether ${lockDir} enforces file locks could not be measured in ${proofDir}: EMFILE: injected`);
  });

  it('a layout whose proof directory is missing gives no lock', async () => {
    const root = makeTemporaryDirectory();
    const callLocks = path.join(root, 'call-locks');
    fs.mkdirSync(callLocks, { mode: 0o700 });
    expect(() => resolveLayoutLocks({ callLocks, lockProof: path.join(root, 'lock-proof') })).toThrow(LockProofFailedError);
  });

  it('a directory that is missing gives no lock', async () => {
    const { proofDir, root } = directories(0o700);
    expect(() => resolveKernelLock(path.join(root, 'absent'), { capability: createLockCapability({ proofDir }) })).toThrow(LockProofFailedError);
  });

  it('the host inspector takes the proof it is given', () => {
    expect(hostInspectorPorts.length).toBe(1);
    expect(sourceOf('process-inspector.ts')).not.toMatch(/hostLockCapability/);
  });
});
