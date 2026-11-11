import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOST_FLAVOUR, compileFileRuleSet, inWritableArea, lexicallyWithin, writableAreaOf, writableCheckOf, ruleEnforcementOf } from '@momonga/foundation';
import type { FileRuleSpec } from '@momonga/foundation';
import { testPaths } from '@momonga/testkit';
import { syncPaths } from '../src/index.ts';


const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const fixture = async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-warea-')));
  tempDirs.push(base);
  const root = path.join(base, 'root');
  const wide = path.join(base, 'wide');
  const unrelated = path.join(base, 'unrelated');
  for (const dir of [root, wide, unrelated]) fs.mkdirSync(dir);
  const widening: FileRuleSpec = {
    ruleIndex: 0,
    tool: 'Edit',
    access: 'write',
    effect: 'allow',
    specifier: `/${wide}/**`,
    exceptions: [],
    context: { roots: [root], home: path.join(base, 'home'), settingsRoot: root, effect: 'allow' },
    provenance: { ruleText: `Edit(/${wide}/**)`, layer: 'user', source: 'user-settings' },
  };
  const fileRules = await compileFileRuleSet([widening], [root], null, syncPaths.resolveCanonicalPath, () => true, HOST_FLAVOUR, ruleEnforcementOf('none'));
  expect(fileRules.entries.map((entry) => entry.widening)).toEqual([true]);
  const area = writableAreaOf({ writableRoots: [root], entries: fileRules.entries });
  return { root, wide, unrelated, area };
};

describe('inWritableArea', () => {
  it.each(['canonical', 'lexical'] as const)('in %s mode holds for a writable root and the widening closure, and not for an unrelated path', async (mode) => {
    const fx = await fixture();
    expect(await inWritableArea((await fx).area, (await fx).root, mode, testPaths())).toBe(true);
    expect(await inWritableArea((await fx).area, path.join((await fx).root, 'x', 'y'), mode, testPaths())).toBe(true);
    expect(await inWritableArea((await fx).area, (await fx).wide, mode, testPaths())).toBe(true);
    expect(await inWritableArea((await fx).area, path.join((await fx).wide, 'k'), mode, testPaths())).toBe(true);
    expect(await inWritableArea((await fx).area, (await fx).unrelated, mode, testPaths())).toBe(false);
    expect(await inWritableArea((await fx).area, path.join((await fx).unrelated, 'z'), mode, testPaths())).toBe(false);
    expect(await inWritableArea((await fx).area, `${(await fx).root}x`, mode, testPaths())).toBe(false);
  });

  it('follows a symlink at the final component in canonical mode and not in lexical mode', async () => {
    const fx = await fixture();
    const target = path.join((await fx).root, 'target');
    fs.mkdirSync(target);
    const intoRoot = path.join((await fx).unrelated, 'link');
    fs.symlinkSync(target, intoRoot);
    expect(await inWritableArea((await fx).area, intoRoot, 'canonical', testPaths())).toBe(true);
    expect(await inWritableArea((await fx).area, intoRoot, 'lexical', testPaths())).toBe(false);

    const away = path.join((await fx).unrelated, 'away');
    fs.mkdirSync(away);
    const outOfRoot = path.join((await fx).root, 'link');
    fs.symlinkSync(away, outOfRoot);
    expect(await inWritableArea((await fx).area, outOfRoot, 'canonical', testPaths())).toBe(false);
    expect(await inWritableArea((await fx).area, outOfRoot, 'lexical', testPaths())).toBe(true);
  });

  it.each(['canonical', 'lexical'] as const)('in %s mode places an NFD spelling of a path under an NFC root or widening area inside the area', async (mode) => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-warea-nfc-')));
    tempDirs.push(base);
    const root = path.join(base, 'caf\u00e9');
    const wide = path.join(base, 'wid\u00e9');
    for (const dir of [root, wide]) fs.mkdirSync(dir);
    const widening: FileRuleSpec = {
      ruleIndex: 0,
      tool: 'Edit',
      access: 'write',
      effect: 'allow',
      specifier: `/${wide}/**`,
      exceptions: [],
      context: { roots: [root], home: path.join(base, 'home'), settingsRoot: root, effect: 'allow' },
      provenance: { ruleText: `Edit(/${wide}/**)`, layer: 'user', source: 'user-settings' },
    };
    const area = writableAreaOf({ writableRoots: [root], entries: await (await compileFileRuleSet([widening], [root], null, syncPaths.resolveCanonicalPath, () => true, HOST_FLAVOUR, ruleEnforcementOf('none'))).entries });
    expect(await inWritableArea(area, path.join(base, 'cafe\u0301', 'x'), mode, testPaths())).toBe(true);
    expect(await inWritableArea(area, path.join(base, 'wide\u0301', 'x'), mode, testPaths())).toBe(true);
    expect(await inWritableArea(area, path.join(base, 'cafe', 'x'), mode, testPaths())).toBe(false);
  });
});

describe('lexical containment of a child whose first name starts with ..', () => {
  it('lexicallyWithin places /r/..cfg inside /r and keeps /r/../x and /rx outside', () => {
    expect(lexicallyWithin('/r/..cfg', '/r')).toBe(true);
    expect(lexicallyWithin('/r/..cfg/k', '/r')).toBe(true);
    expect(lexicallyWithin('/r/../x', '/r')).toBe(false);
    expect(lexicallyWithin('/rx', '/r')).toBe(false);
    expect(lexicallyWithin('/r/..', '/r')).toBe(false);
  });

  it('inWritableArea in lexical mode places /r/..cfg inside the root /r and keeps /r/../x and /rx outside', async () => {
    const area = writableAreaOf({ writableRoots: ['/r'], entries: [] });
    expect(await inWritableArea(area, '/r/..cfg', 'lexical', testPaths())).toBe(true);
    expect(await inWritableArea(area, '/r/../x', 'lexical', testPaths())).toBe(false);
    expect(await inWritableArea(area, '/rx', 'lexical', testPaths())).toBe(false);
  });
});

describe('writableCheckOf', () => {
  const area = () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-wcheck-')));
    tempDirs.push(base);
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    for (const dir of [root, outside]) fs.mkdirSync(dir);
    return { root, outside, check: writableCheckOf(writableAreaOf({ writableRoots: [root], entries: [] }), testPaths()) };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is true for an entry inside the writable area, including one that does not exist yet', async () => {
    const { root, check } = area();
    expect(await check(path.join(root, 'bin'))).toBe(true);
    expect(await check(path.join(root, 'node_modules', '.bin'))).toBe(true);
  });

  it('is false for an entry outside the writable area', async () => {
    const { outside, check } = area();
    expect(await check(outside)).toBe(false);
    expect(await check('/opt/homebrew/bin')).toBe(false);
  });

  it('is true when the entry resolves with an unresolvable errno', async () => {
    const { outside, check } = area();
    const loop = path.join(outside, 'loop');
    fs.symlinkSync(loop, loop);
    expect(await check(path.join(loop, 'bin'))).toBe(true);
  });

  it('rethrows any other error unchanged', async () => {
    const { outside, check } = area();
    const target = path.join(outside, 'broken');
    const eio = Object.assign(new Error('EIO: injected'), { code: 'EIO' });
    const original = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (candidate: fs.PathLike, ...rest: unknown[]) => {
      if (candidate === target) throw eio;
      return (original as (...args: unknown[]) => unknown)(candidate, ...rest);
    }) as typeof fs.promises.lstat);
    await expect(check(target)).rejects.toBe(eio);
  });
});
