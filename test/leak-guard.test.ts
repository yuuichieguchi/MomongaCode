import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shortTempBase } from '@momonga/foundation';
import { testTempBases, withTempDir } from '@momonga/testkit';
import { assertNoLeakedTempDirs, leakedTempDirs, newRunToken } from './support/leak-guard.ts';

describe('leak guard', () => {
  it('generates a four-hex run token', () => {
    expect(newRunToken()).toMatch(/^[0-9a-f]{4}$/);
  });

  it('lists only directories carrying this run token', (context) => {
    const root = withTempDir(context);
    for (const name of ['mmt-abcd-111111', 'mmt-abcd-222222', 'mmt-ffff-333333', 'mm-abcd-444444', 'mmt-abcde-55555']) {
      fs.mkdirSync(path.join(root, name));
    }
    expect(leakedTempDirs(root, 'abcd')).toEqual(['mmt-abcd-111111', 'mmt-abcd-222222']);
  });

  it('fails naming the leaked directories and never deletes them', (context) => {
    const root = withTempDir(context);
    fs.mkdirSync(path.join(root, 'mmt-abcd-111111'));
    fs.mkdirSync(path.join(root, 'mmt-ffff-333333'));
    expect(() => assertNoLeakedTempDirs([root], 'abcd')).toThrow('mmt-abcd-111111');
    expect(() => assertNoLeakedTempDirs([root], 'ffff')).toThrow('mmt-ffff-333333');
    expect(fs.readdirSync(root).sort()).toEqual(['mmt-abcd-111111', 'mmt-ffff-333333']);
  });

  it('passes when nothing of this run is left', (context) => {
    const root = withTempDir(context);
    fs.mkdirSync(path.join(root, 'mmt-ffff-333333'));
    expect(() => assertNoLeakedTempDirs([root], 'abcd')).not.toThrow();
  });

  it('names what is left in every base it is given', (context) => {
    const first = withTempDir(context);
    const second = withTempDir(context);
    fs.mkdirSync(path.join(first, 'mmt-abcd-111111'));
    fs.mkdirSync(path.join(second, 'mmt-abcd-222222'));
    expect(() => assertNoLeakedTempDirs([first, second], 'abcd')).toThrow(`${path.join(first, 'mmt-abcd-111111')}, ${path.join(second, 'mmt-abcd-222222')}`);
  });

  it('sweeps the base of homes and the base of other directories', () => {
    expect(testTempBases()).toEqual([...new Set([shortTempBase(process.platform), os.tmpdir()].map((base) => fs.realpathSync(base)))]);
  });
});
