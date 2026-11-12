import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setCaseSensitivityProbe } from '@momonga/foundation';
import { syncPaths } from '../src/index.ts';
import { createTempDir } from '@momonga/testkit';

const UNDETERMINED = 'case sensitivity of this volume could not be determined';

const tempDirs: string[] = [];

afterEach(() => {
  setCaseSensitivityProbe(undefined);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = createTempDir();
  tempDirs.push(dir);
  return dir;
};

describe('case sensitivity when the probe cannot decide (B10)', () => {
  it('answers unmeasured with the probe error as the reason when the probe throws', () => {
    setCaseSensitivityProbe(() => {
      throw new Error('EIO reading the directory');
    });
    const root = makeDir();
    const result = syncPaths.caseSensitivityOf(path.join(root, 'Target'));
    expect(result.kind).toBe('unmeasured');
    expect(result.evidence).toContain(UNDETERMINED);
    expect(result.evidence).toContain('EIO reading the directory');
    expect(result.evidence).toContain(root);
  });

  it('does not cache an unmeasured answer: the next call measures again', () => {
    let calls = 0;
    setCaseSensitivityProbe(() => {
      calls += 1;
      if (calls === 1) throw new Error('EIO reading the directory');
      return true;
    });
    const root = makeDir();
    expect(syncPaths.caseSensitivityOf(path.join(root, 'Target')).kind).toBe('unmeasured');
    expect(syncPaths.caseSensitivityOf(path.join(root, 'Target'))).toMatchObject({ kind: 'supported', value: true });
    expect(calls).toBe(2);
  });

  it('answers unsupported when the probe finds no entry to compare', () => {
    setCaseSensitivityProbe(() => undefined);
    const root = makeDir();
    const result = syncPaths.caseSensitivityOf(path.join(root, 'Target'));
    expect(result.kind).toBe('unsupported');
    expect(result.evidence).toContain(UNDETERMINED);
    expect(result.evidence).toContain(root);
  });

  it('caches an unsupported answer: the next call does not measure again', () => {
    let calls = 0;
    setCaseSensitivityProbe(() => {
      calls += 1;
      return calls === 1 ? undefined : true;
    });
    const root = makeDir();
    expect(syncPaths.caseSensitivityOf(path.join(root, 'Target')).kind).toBe('unsupported');
    const second = syncPaths.caseSensitivityOf(path.join(root, 'Target'));
    expect(second.kind).toBe('unsupported');
    expect(second.evidence).toContain(UNDETERMINED);
    expect(calls).toBe(1);
  });

  it('never returns a boolean guessed from the platform name', async () => {
    setCaseSensitivityProbe(() => {
      throw new Error('probe failed');
    });
    const root = makeDir();
    await expect((async () => syncPaths.volumeIsCaseInsensitive(path.join(root, 'Target')))()).rejects.toThrow(UNDETERMINED);
  });

  it('answers supported with the measured verdict when the probe decides', () => {
    setCaseSensitivityProbe(() => true);
    const root = makeDir();
    expect(syncPaths.caseSensitivityOf(path.join(root, 'Target'))).toMatchObject({ kind: 'supported', value: true });
    setCaseSensitivityProbe(() => false);
    expect(syncPaths.caseSensitivityOf(path.join(root, 'Target'))).toMatchObject({ kind: 'supported', value: false });
  });
});
