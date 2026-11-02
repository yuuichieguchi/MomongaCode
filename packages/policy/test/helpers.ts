import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { computeFileRules, parseRule } from '@momonga/policy';
import { EMPTY_PROTECTED_SET, protectedSetFor } from '@momonga/foundation';
import type { FileRuleSet, ProtectedSet } from '@momonga/foundation';
import { TEST_SEARCH_PATH, fakePolicyFilesystem, isWritableFor, protectedSetWith } from '@momonga/testkit';
import type { FakePolicyFilesystemLayout } from '@momonga/testkit';
import type { PermissionRule, PolicyFilesystem, RuleEffect, RuleOrigin } from '@momonga/policy';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

export type Layout = { root: string; home: string; project: string; outside: string; settingsRoot: string };

export const makeLayout = (): Layout => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-pol-')));
  fs.chmodSync(root, 0o700);
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = {
    root,
    home: path.join(root, 'home'),
    project: path.join(root, 'project'),
    outside: path.join(root, 'outside'),
    settingsRoot: path.join(root, 'settings-root'),
  };
  for (const dir of [layout.home, layout.project, layout.outside, layout.settingsRoot]) fs.mkdirSync(dir, { mode: 0o700 });
  return layout;
};

export const touch = (file: string): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, 'x', { mode: 0o600 });
  return file;
};

export const ruleIn =
  (layout: Layout, origin: RuleOrigin = 'user') =>
  (effect: RuleEffect, text: string): PermissionRule =>
    parseRule(text, { effect, origin, source: `${origin}-settings`, settingsRoot: layout.project, home: layout.home, cwd: layout.project });

export const fileRulesFor = (rules: readonly PermissionRule[], roots: readonly string[]): FileRuleSet => computeFileRules(rules, roots, null);

export type FakeFsLayout = FakePolicyFilesystemLayout;

export const fakeFs = (layout: FakeFsLayout = {}): PolicyFilesystem => fakePolicyFilesystem(layout);

export const protectedSetOf = (roots: readonly string[], filesystem: PolicyFilesystem = fakeFs()): ProtectedSet =>
  roots.length === 0 ? EMPTY_PROTECTED_SET : protectedSetFor(roots, filesystem);

export { TEST_SEARCH_PATH, isWritableFor, protectedSetWith };
