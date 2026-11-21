import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultOutputSettings, mergeOutputSettings, writeOutputStyleSetting } from '@momonga/config';
import { createTempDir, testKernelLock } from '@momonga/testkit';
import { assertSettings } from '../src/settings.ts';

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('output.style setting', () => {
  it('defaults to standard and merges overrides', () => {
    expect(defaultOutputSettings()).toEqual({ style: 'standard' });
    expect(mergeOutputSettings(defaultOutputSettings(), undefined)).toEqual({ style: 'standard' });
    expect(mergeOutputSettings(defaultOutputSettings(), { style: 'concise' })).toEqual({ style: 'concise' });
  });

  it('validates output.style in settings schema', () => {
    expect(assertSettings({ output: { style: 'explanatory' } }, 'test').output).toEqual({ style: 'explanatory' });
    expect(() => assertSettings({ output: { style: 'verbose' } }, 'test')).toThrow(/invalid settings/);
  });

  it('writes and removes output.style in user settings.json', async () => {
    const home = createTempDir();
    dirs.push(home);
    const settingsFile = path.join(home, 'settings.json');
    const signal = new AbortController().signal;

    await writeOutputStyleSetting(home, settingsFile, 'concise', { lock: testKernelLock(), signal });
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({ output: { style: 'concise' } });

    await writeOutputStyleSetting(home, settingsFile, undefined, { lock: testKernelLock(), signal });
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({});
  });
});
