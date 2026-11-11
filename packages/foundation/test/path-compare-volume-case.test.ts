import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setCaseSensitivityProbe } from '@momonga/foundation';
import { syncPaths } from '../src/index.ts';

const tempDirs: string[] = [];

afterEach(() => {
  setCaseSensitivityProbe(undefined);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-vcase-')));
  tempDirs.push(dir);
  return dir;
};

const kernelFoldsCase = (): boolean => {
  const probe = path.join(makeDir(), 'CaseProbe');
  fs.mkdirSync(probe);
  try {
    return fs.statSync(probe).ino === fs.statSync(path.join(path.dirname(probe), 'caseprobe')).ino;
  } catch {
    return false;
  }
};

const CASE_INSENSITIVE = kernelFoldsCase();

describe('the real probe', () => {
  it('reports the case sensitivity the kernel applies on the temp volume', () => {
    expect(syncPaths.volumeIsCaseInsensitive(makeDir())).toBe(CASE_INSENSITIVE);
  });

  it('reports the same answer for a missing path below an existing directory on that volume', () => {
    expect(syncPaths.volumeIsCaseInsensitive(path.join(makeDir(), 'missing', 'deeper'))).toBe(CASE_INSENSITIVE);
  });

  it.runIf(CASE_INSENSITIVE)('matches missing-tail case variants on a case-insensitive temp volume', () => {
    const root = makeDir();
    expect(syncPaths.comparableContains(path.join(root, 'Missing'), path.join(root, 'missing', 'child'))).toBe(true);
  });
});

describe('with an injected case-sensitive probe', () => {
  it('does not treat /x/Project as inside /x/project when both are missing', () => {
    setCaseSensitivityProbe(() => false);
    const root = makeDir();
    expect(syncPaths.comparableContains(path.join(root, 'project'), path.join(root, 'Project'))).toBe(false);
    expect(syncPaths.comparableContains(path.join(root, 'project'), path.join(root, 'Project', 'file'))).toBe(false);
    expect(syncPaths.comparablePath(path.join(root, 'Project'))).not.toBe(syncPaths.comparablePath(path.join(root, 'project')));
  });

  it('still contains an exact descendant', () => {
    setCaseSensitivityProbe(() => false);
    const root = makeDir();
    expect(syncPaths.comparableContains(path.join(root, 'Project'), path.join(root, 'Project', 'file'))).toBe(true);
  });

  it.runIf(CASE_INSENSITIVE)('compares existing components by their true-case canonical form', () => {
    setCaseSensitivityProbe(() => false);
    const root = makeDir();
    fs.mkdirSync(path.join(root, 'Work'));
    expect(syncPaths.comparablePath(path.join(root, 'work'))).toBe(syncPaths.comparablePath(path.join(root, 'Work')));
  });
});

describe('with an injected case-insensitive probe', () => {
  it('matches missing-tail case variants', () => {
    setCaseSensitivityProbe(() => true);
    const root = makeDir();
    expect(syncPaths.comparableContains(path.join(root, 'Missing'), path.join(root, 'missing', 'child'))).toBe(true);
    expect(syncPaths.comparableContains(path.join(root, 'Missing'), path.join(root, 'MISSING'))).toBe(true);
    expect(syncPaths.comparablePath(path.join(root, 'Missing'))).toBe(syncPaths.comparablePath(path.join(root, 'missing')));
  });

  it('still rejects a sibling that only shares a prefix', () => {
    setCaseSensitivityProbe(() => true);
    const root = makeDir();
    expect(syncPaths.comparableContains(path.join(root, 'Missing'), path.join(root, 'missing-x'))).toBe(false);
  });
});

describe('probe caching', () => {
  it('probes an existing directory once per device', () => {
    const probed: string[] = [];
    setCaseSensitivityProbe((directory) => {
      probed.push(directory);
      return true;
    });
    const root = makeDir();
    syncPaths.comparableContains(path.join(root, 'A'), path.join(root, 'a', 'b'));
    syncPaths.comparableContains(path.join(root, 'C'), path.join(root, 'c', 'd'));
    syncPaths.comparablePath(path.join(root, 'E', 'f'));
    expect(syncPaths.volumeIsCaseInsensitive(path.join(root, 'G'))).toBe(true);
    expect(probed).toHaveLength(1);
    expect(fs.statSync(probed[0] as string).isDirectory()).toBe(true);
  });

  it('refuses to guess when the probe cannot decide, naming the volume as unsupported', async () => {
    setCaseSensitivityProbe(() => undefined);
    const root = makeDir();
    await expect((async () => syncPaths.volumeIsCaseInsensitive(path.join(root, 'Missing')))()).rejects.toThrow('case sensitivity of this volume could not be determined');
    await expect((async () => syncPaths.comparableContains(path.join(root, 'Missing'), path.join(root, 'missing', 'child')))()).rejects.toThrow('case sensitivity of this volume could not be determined');
  });
});
