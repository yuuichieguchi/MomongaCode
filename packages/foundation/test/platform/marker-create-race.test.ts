import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFileSystemSync } from '../../src/node-file-system.ts';
import { StagingLinkError, createLockCapability } from '../../src/platform/lock-capability.ts';
import { createMarker } from '../../src/platform/marker-file.ts';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';
import { fixedCapability, stalledSharedProbe, twoStepCreateLockOps } from '../support/probe-fakes.ts';
import type { ProbeSighting } from '../support/probe-fakes.ts';

const directories = () => {
  const root = makeTemporaryDirectory();
  const proofDir = path.join(root, 'run', 'lock-proof');
  const markerDir = path.join(root, 'run', 'markers', 'tools');
  fs.mkdirSync(proofDir, { recursive: true });
  fs.mkdirSync(markerDir, { recursive: true });
  return { proofDir, markerDir };
};

describe('T7 (b) on a kernel that creates the file before it locks it, a probe that lands in between never sees the marker unlocked', () => {
  it('createMarker succeeds locked while a stalled probe holds whatever it could lock at the marker name, and the probe never saw the marker unlocked', async () => {
    const { markerDir } = directories();
    const marker = path.join(markerDir, 'call-1');
    const sightings: ProbeSighting[] = [];
    const ops = twoStepCreateLockOps((probing) => sightings.push(stalledSharedProbe(probing, marker)));
    const handle = await createMarker(marker, { capability: fixedCapability('proved'), ops });
    try {
      expect(handle.mode).toBe('locked');
      expect(sightings).not.toContain('unlocked');
      expect(stalledSharedProbe(ops, marker)).toBe('held');
      expect(fs.readFileSync(marker, 'utf8')).toBe('r00000\n');
    } finally {
      handle.close();
    }
    expect(fs.readdirSync(markerDir)).toEqual(['call-1']);
  });

  it('a name that already exists is refused with EEXIST and the existing marker is left as it was', async () => {
    const { markerDir } = directories();
    const marker = path.join(markerDir, 'call-1');
    const ops = twoStepCreateLockOps(() => undefined);
    const first = await createMarker(marker, { capability: fixedCapability('proved'), ops });
    try {
      await expect(createMarker(marker, { capability: fixedCapability('proved'), ops })).rejects.toMatchObject({ code: 'EEXIST' });
      expect(stalledSharedProbe(ops, marker)).toBe('held');
    } finally {
      first.close();
    }
  });

  it('the lock proof is proved while another process sweeps the proof directory with stalled shared probes between the create and the lock', async () => {
    const { proofDir, markerDir } = directories();
    const sightings: ProbeSighting[] = [];
    const ops = twoStepCreateLockOps((probing) => {
      for (const name of fs.readdirSync(proofDir)) sightings.push(stalledSharedProbe(probing, path.join(proofDir, name)));
    });
    expect(await createLockCapability({ proofDir, ops }).of(markerDir)).toBe('proved');
    expect(sightings).not.toContain('unlocked');
  });
});

describe('T7 (b) a staging place on another filesystem than the marker is refused with a typed error', () => {
  const crossDeviceLink = {
    ...nodeFileSystemSync,
    linkSync: (): void => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted, link'), { code: 'EXDEV' });
    },
  };

  it('createMarker rejects with StagingLinkError naming both paths and the reason, and leaves neither file behind', async () => {
    const { markerDir } = directories();
    const marker = path.join(markerDir, 'call-1');
    const failure = await createMarker(marker, { capability: fixedCapability('proved'), ops: twoStepCreateLockOps(() => undefined), files: crossDeviceLink }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StagingLinkError);
    const staged = (failure as StagingLinkError).stagingPath;
    expect(path.dirname(staged)).toBe(path.dirname(markerDir));
    expect(path.basename(staged)).toMatch(/^\.tools\.call-1\.[0-9a-f]{8,}\.creating$/);
    expect(failure).toMatchObject({ name: 'StagingLinkError', targetPath: marker });
    expect((failure as Error).message).toBe(`${staged} cannot be hard-linked to ${marker}: the two paths are on different filesystems, so the locked file cannot be given its name without a moment in which it exists unlocked`);
    expect(((failure as Error).cause as NodeJS.ErrnoException).code).toBe('EXDEV');
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(staged)).toBe(false);
  });
});
