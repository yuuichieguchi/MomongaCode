import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileFileRuleSet, inWritableArea, lexicallyWithin, resolveCanonicalPath, writableAreaOf } from '@momonga/foundation';
import type { FileRuleSpec } from '@momonga/foundation';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const fixture = () => {
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
  const fileRules = compileFileRuleSet([widening], [root], null, resolveCanonicalPath, () => true);
  expect(fileRules.entries.map((entry) => entry.widening)).toEqual([true]);
  const area = writableAreaOf({ writableRoots: [root], entries: fileRules.entries });
  return { root, wide, unrelated, area };
};

describe('inWritableArea', () => {
  it.each(['canonical', 'lexical'] as const)('in %s mode holds for a writable root and the widening closure, and not for an unrelated path', (mode) => {
    const fx = fixture();
    expect(inWritableArea(fx.area, fx.root, mode)).toBe(true);
    expect(inWritableArea(fx.area, path.join(fx.root, 'x', 'y'), mode)).toBe(true);
    expect(inWritableArea(fx.area, fx.wide, mode)).toBe(true);
    expect(inWritableArea(fx.area, path.join(fx.wide, 'k'), mode)).toBe(true);
    expect(inWritableArea(fx.area, fx.unrelated, mode)).toBe(false);
    expect(inWritableArea(fx.area, path.join(fx.unrelated, 'z'), mode)).toBe(false);
    expect(inWritableArea(fx.area, `${fx.root}x`, mode)).toBe(false);
  });

  it('follows a symlink at the final component in canonical mode and not in lexical mode', () => {
    const fx = fixture();
    const target = path.join(fx.root, 'target');
    fs.mkdirSync(target);
    const intoRoot = path.join(fx.unrelated, 'link');
    fs.symlinkSync(target, intoRoot);
    expect(inWritableArea(fx.area, intoRoot, 'canonical')).toBe(true);
    expect(inWritableArea(fx.area, intoRoot, 'lexical')).toBe(false);

    const away = path.join(fx.unrelated, 'away');
    fs.mkdirSync(away);
    const outOfRoot = path.join(fx.root, 'link');
    fs.symlinkSync(away, outOfRoot);
    expect(inWritableArea(fx.area, outOfRoot, 'canonical')).toBe(false);
    expect(inWritableArea(fx.area, outOfRoot, 'lexical')).toBe(true);
  });

  it.each(['canonical', 'lexical'] as const)('in %s mode places an NFD spelling of a path under an NFC root or widening area inside the area', (mode) => {
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
    const area = writableAreaOf({ writableRoots: [root], entries: compileFileRuleSet([widening], [root], null, resolveCanonicalPath, () => true).entries });
    expect(inWritableArea(area, path.join(base, 'cafe\u0301', 'x'), mode)).toBe(true);
    expect(inWritableArea(area, path.join(base, 'wide\u0301', 'x'), mode)).toBe(true);
    expect(inWritableArea(area, path.join(base, 'cafe', 'x'), mode)).toBe(false);
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

  it('inWritableArea in lexical mode places /r/..cfg inside the root /r and keeps /r/../x and /rx outside', () => {
    const area = writableAreaOf({ writableRoots: ['/r'], entries: [] });
    expect(inWritableArea(area, '/r/..cfg', 'lexical')).toBe(true);
    expect(inWritableArea(area, '/r/../x', 'lexical')).toBe(false);
    expect(inWritableArea(area, '/rx', 'lexical')).toBe(false);
  });
});
