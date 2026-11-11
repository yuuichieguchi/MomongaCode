import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setCaseSensitivityProbe } from '@momonga/foundation';
import { matchRule } from '@momonga/policy';
import type { PermissionSubject } from '@momonga/policy';
import { fileRulesFor, makeLayout, ruleIn } from './helpers.ts';
import { testProbes } from '@momonga/testkit';

afterEach(() => {
  setCaseSensitivityProbe(undefined);
});

const deviceOf = (target: string): number | undefined => {
  try {
    return fs.statSync(target).dev;
  } catch {
    return undefined;
  }
};

const VM = '/System/Volumes/VM';
const VM_IS_SEPARATE_MOUNT = deviceOf(VM) !== undefined && deviceOf(VM) !== deviceOf('/System/Volumes');
const RUNNING_AS_ROOT = process.getuid?.() === 0;

const read = (file: string): PermissionSubject => ({ kind: 'path', tool: 'Read', paths: [file], access: 'read' });

describe.runIf(VM_IS_SEPARATE_MOUNT)('pathMatchesRule folding across a mount boundary', () => {
  it('folds both sides once ignoreCase is decided from the target', async () => {
    setCaseSensitivityProbe((directory) => directory === VM || directory.startsWith(`${VM}/`));
    const rule = ruleIn(makeLayout())('deny', 'Read(//System/Volumes/**)');
    expect(await matchRule(rule, read(`${VM}/Missing/file`), await fileRulesFor([rule], [rule.cwd]), 0, testProbes().canonicalise)).toBe(true);
  });
});

describe.skipIf(RUNNING_AS_ROOT)('pathMatchesRule under an unreadable directory', () => {
  it('returns a decision for a target under a 000 directory', async () => {
    const layout = makeLayout();
    const locked = path.join(layout.root, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      const rule = ruleIn(layout)('deny', `Read(/${locked}/**)`);
      expect(await matchRule(rule, read(path.join(locked, 'x', 'y')), await fileRulesFor([rule], [rule.cwd]), 0, testProbes().canonicalise)).toBe(true);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});
