import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { caseSensitivityOf, setCaseSensitivityProbe, volumeIsCaseInsensitive } from '@momonga/foundation';

const UNDETERMINED = 'case sensitivity of this volume could not be determined';

const tempDirs: string[] = [];

afterEach(() => {
  setCaseSensitivityProbe(undefined);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-vunsup-')));
  tempDirs.push(dir);
  return dir;
};

describe('case sensitivity when the probe cannot decide (B10)', () => {
  it('answers unsupported with the probe error as the reason when the probe throws', () => {
    setCaseSensitivityProbe(() => {
      throw new Error('EIO reading the directory');
    });
    const root = makeDir();
    const result = caseSensitivityOf(path.join(root, 'Target'));
    expect(result.kind).toBe('unsupported');
    expect(result.evidence).toContain(UNDETERMINED);
    expect(result.evidence).toContain('EIO reading the directory');
    expect(result.evidence).toContain(root);
  });

  it('answers unsupported when the probe finds no entry to compare', () => {
    setCaseSensitivityProbe(() => undefined);
    const root = makeDir();
    const result = caseSensitivityOf(path.join(root, 'Target'));
    expect(result.kind).toBe('unsupported');
    expect(result.evidence).toContain(UNDETERMINED);
    expect(result.evidence).toContain(root);
  });

  it('never returns a boolean guessed from the platform name', () => {
    setCaseSensitivityProbe(() => {
      throw new Error('probe failed');
    });
    const root = makeDir();
    expect(() => volumeIsCaseInsensitive(path.join(root, 'Target'))).toThrow(UNDETERMINED);
  });

  it('answers supported with the measured verdict when the probe decides', () => {
    setCaseSensitivityProbe(() => true);
    const root = makeDir();
    expect(caseSensitivityOf(path.join(root, 'Target'))).toMatchObject({ kind: 'supported', value: true });
    setCaseSensitivityProbe(() => false);
    expect(caseSensitivityOf(path.join(root, 'Target'))).toMatchObject({ kind: 'supported', value: false });
  });
});
