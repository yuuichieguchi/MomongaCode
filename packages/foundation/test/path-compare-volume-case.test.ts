import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { comparableContains, comparablePath, setCaseSensitivityProbe, volumeIsCaseInsensitive } from '@momonga/foundation';

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
const PLATFORM_DEFAULT = process.platform === 'darwin' || process.platform === 'win32';

describe('the real probe', () => {
  it('reports the case sensitivity the kernel applies on the temp volume', () => {
    expect(volumeIsCaseInsensitive(makeDir())).toBe(CASE_INSENSITIVE);
  });

  it('reports the same answer for a missing path below an existing directory on that volume', () => {
    expect(volumeIsCaseInsensitive(path.join(makeDir(), 'missing', 'deeper'))).toBe(CASE_INSENSITIVE);
  });

  it.runIf(CASE_INSENSITIVE)('matches missing-tail case variants on a case-insensitive temp volume', () => {
    const root = makeDir();
    expect(comparableContains(path.join(root, 'Missing'), path.join(root, 'missing', 'child'))).toBe(true);
  });
});

describe('with an injected case-sensitive probe', () => {
  it('does not treat /x/Project as inside /x/project when both are missing', () => {
    setCaseSensitivityProbe(() => false);
    const root = makeDir();
    expect(comparableContains(path.join(root, 'project'), path.join(root, 'Project'))).toBe(false);
    expect(comparableContains(path.join(root, 'project'), path.join(root, 'Project', 'file'))).toBe(false);
    expect(comparablePath(path.join(root, 'Project'))).not.toBe(comparablePath(path.join(root, 'project')));
  });

  it('still contains an exact descendant', () => {
    setCaseSensitivityProbe(() => false);
    const root = makeDir();
    expect(comparableContains(path.join(root, 'Project'), path.join(root, 'Project', 'file'))).toBe(true);
  });

  it.runIf(CASE_INSENSITIVE)('compares existing components by their true-case canonical form', () => {
    setCaseSensitivityProbe(() => false);
    const root = makeDir();
    fs.mkdirSync(path.join(root, 'Work'));
    expect(comparablePath(path.join(root, 'work'))).toBe(comparablePath(path.join(root, 'Work')));
  });
});

describe('with an injected case-insensitive probe', () => {
  it('matches missing-tail case variants', () => {
    setCaseSensitivityProbe(() => true);
    const root = makeDir();
    expect(comparableContains(path.join(root, 'Missing'), path.join(root, 'missing', 'child'))).toBe(true);
    expect(comparableContains(path.join(root, 'Missing'), path.join(root, 'MISSING'))).toBe(true);
    expect(comparablePath(path.join(root, 'Missing'))).toBe(comparablePath(path.join(root, 'missing')));
  });

  it('still rejects a sibling that only shares a prefix', () => {
    setCaseSensitivityProbe(() => true);
    const root = makeDir();
    expect(comparableContains(path.join(root, 'Missing'), path.join(root, 'missing-x'))).toBe(false);
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
    comparableContains(path.join(root, 'A'), path.join(root, 'a', 'b'));
    comparableContains(path.join(root, 'C'), path.join(root, 'c', 'd'));
    comparablePath(path.join(root, 'E', 'f'));
    expect(volumeIsCaseInsensitive(path.join(root, 'G'))).toBe(true);
    expect(probed).toHaveLength(1);
    expect(fs.statSync(probed[0] as string).isDirectory()).toBe(true);
  });

  it('falls back to the platform default when the probe cannot decide', () => {
    setCaseSensitivityProbe(() => undefined);
    const root = makeDir();
    expect(volumeIsCaseInsensitive(path.join(root, 'Missing'))).toBe(PLATFORM_DEFAULT);
    expect(comparableContains(path.join(root, 'Missing'), path.join(root, 'missing', 'child'))).toBe(PLATFORM_DEFAULT);
  });
});
