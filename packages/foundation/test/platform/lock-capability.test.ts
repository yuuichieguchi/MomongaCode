import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nodeFileLockOps } from '../../src/platform/kernel-lock.ts';
import { createLockCapability } from '../../src/platform/lock-capability.ts';
import { momongaLayout } from '../../src/momonga-paths.ts';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';
import { LOCK_FLAG_BITS, countingOps, lockIgnoringOps, lockRejectingOps, switchableOps } from '../support/probe-fakes.ts';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'platform', 'lock-capability.ts');

const directories = () => {
  const root = makeTemporaryDirectory();
  const proofDir = path.join(root, 'run', 'lock-proof');
  const markerDir = path.join(root, 'run', 'markers', 'tools');
  fs.mkdirSync(proofDir, { recursive: true });
  fs.mkdirSync(markerDir, { recursive: true });
  return { root, proofDir, markerDir };
};

const realIdentity = (dir: string) => {
  const stat = fs.statSync(dir, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
};

const opensIn = (opened: ReadonlyArray<{ path: string }>, dir: string): number => opened.filter((entry) => path.dirname(entry.path) === dir).length;

describe.runIf(process.platform === 'darwin')('T3 the lock is trusted only where the conflict test proved it (this host enforces BSD locks)', () => {
  it('measures proved on a directory of the real filesystem', async () => {
    const { proofDir, markerDir } = directories();
    expect(await createLockCapability({ proofDir }).of(markerDir)).toBe('proved');
  });
});

describe('T3 lock proof and detection', () => {
  it('(b) a filesystem whose second open never refuses the shared lock is unenforced', async () => {
    const { proofDir, markerDir } = directories();
    expect(await createLockCapability({ proofDir, ops: lockIgnoringOps() }).of(markerDir)).toBe('unenforced');
  });

  it.for(['ENOTSUP', 'EOPNOTSUPP', 'EINVAL'])('(c) a filesystem that rejects the lock flags with %s is unenforced', async (code) => {
    const { proofDir, markerDir } = directories();
    expect(await createLockCapability({ proofDir, ops: lockRejectingOps(code) }).of(markerDir)).toBe('unenforced');
  });

  it('(d) the proof directory is <run>/lock-proof and lies under no marker directory a sweep is given', () => {
    const paths = momongaLayout('/Users/someone', 'darwin', {});
    expect((paths as { lockProof?: string }).lockProof).toBe(path.join(paths.run, 'lock-proof'));
    const proof = (paths as { lockProof?: string }).lockProof ?? '';
    for (const markers of Object.values(paths.markers)) {
      expect(proof === markers || proof.startsWith(`${markers}${path.sep}`)).toBe(false);
    }
  });

  it('(d) a proof never creates a file in the marker directory it measures', async () => {
    const { proofDir, markerDir } = directories();
    const { ops, opened } = countingOps(lockIgnoringOps());
    await createLockCapability({ proofDir, ops }).of(markerDir);
    expect(opened.length).toBeGreaterThan(0);
    expect(opensIn(opened, markerDir)).toBe(0);
    expect(fs.readdirSync(markerDir)).toEqual([]);
    expect(fs.readdirSync(proofDir)).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('(d) a leftover proof file of a killed prover is removed by the next successful proof; one locked by a live prover is kept', async () => {
    const { proofDir, markerDir } = directories();
    const leftover = path.join(proofDir, 'leftover-of-a-killed-prover');
    fs.writeFileSync(leftover, '');
    const live = path.join(proofDir, 'proof-of-a-live-prover');
    const liveDescriptor = fs.openSync(live, fs.constants.O_RDONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | 0x20 | fs.constants.O_NONBLOCK, 0o600);
    try {
      expect(await createLockCapability({ proofDir }).of(markerDir)).toBe('proved');
      expect(fs.readdirSync(proofDir).sort()).toEqual(['proof-of-a-live-prover']);
    } finally {
      fs.closeSync(liveDescriptor);
    }
  });

  it.runIf(process.platform === 'darwin')('(e) a measurement is cached: a second use with the same st_dev runs no second proof', async () => {
    const { proofDir, markerDir } = directories();
    const { ops, opened } = countingOps(nodeFileLockOps);
    const capability = createLockCapability({ proofDir, ops, statDirectory: realIdentity });
    expect(await capability.of(markerDir)).toBe('proved');
    const afterFirst = opensIn(opened, proofDir);
    expect(afterFirst).toBeGreaterThan(0);
    expect(await capability.of(markerDir)).toBe('proved');
    expect(opensIn(opened, proofDir)).toBe(afterFirst);
  });

  it.runIf(process.platform === 'darwin')('(e) a changed st_dev re-runs the proof, so an unenforced directory remounted on an enforcing filesystem becomes proved', async () => {
    const { proofDir, markerDir } = directories();
    const counted = countingOps(nodeFileLockOps);
    const switchable = switchableOps(lockIgnoringOps(counted.ops));
    let device = 7n;
    const statDirectory = (_dir: string) => ({ dev: device, ino: 11n });
    const capability = createLockCapability({ proofDir, ops: switchable.ops, statDirectory });
    expect(await capability.of(markerDir)).toBe('unenforced');
    const afterFirst = opensIn(counted.opened, proofDir);
    expect(await capability.of(markerDir)).toBe('unenforced');
    expect(opensIn(counted.opened, proofDir)).toBe(afterFirst);
    switchable.use(counted.ops);
    device = 8n;
    expect(await capability.of(markerDir)).toBe('proved');
    expect(opensIn(counted.opened, proofDir)).toBeGreaterThan(afterFirst);
  });

  it('(e) EMFILE during the proof is unmeasured, is not cached, and the next use measures again', async () => {
    const { proofDir, markerDir } = directories();
    let failing = true;
    let attempts = 0;
    const ops = {
      ...lockIgnoringOps(),
      open: (lockPath: string, flags: number, mode?: number) => {
        attempts += 1;
        if (failing) throw Object.assign(new Error('EMFILE: injected'), { code: 'EMFILE' });
        return nodeFileLockOps.open(lockPath, flags & ~LOCK_FLAG_BITS, mode);
      },
    };
    const capability = createLockCapability({ proofDir, ops });
    expect(await capability.of(markerDir)).toBe('unmeasured');
    failing = false;
    const before = attempts;
    expect(await capability.of(markerDir)).toBe('unenforced');
    expect(attempts).toBeGreaterThan(before);
  });

  it('(f) a marker directory on another device than the proof directory is unmeasured', async () => {
    const { proofDir, markerDir } = directories();
    const statDirectory = (dir: string) => ({ dev: dir === markerDir ? 99n : 1n, ino: 5n });
    expect(await createLockCapability({ proofDir, statDirectory }).of(markerDir)).toBe('unmeasured');
  });

  it('(g) a host that does not define the flags takes no lock on open, and is unenforced; the module has no platform branch', async () => {
    const { proofDir, markerDir } = directories();
    expect(await createLockCapability({ proofDir, ops: lockIgnoringOps() }).of(markerDir)).toBe('unenforced');
    expect(fs.readFileSync(SOURCE, 'utf8')).not.toContain('process.platform');
  });
});
