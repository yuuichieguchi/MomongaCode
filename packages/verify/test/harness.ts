import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { HOST_RULE_ENFORCEMENT, protectedSetFor } from '@momonga/foundation';
import { parseRule } from '@momonga/policy';
import type { PermissionRule, PolicyFilesystem, RuleEffect } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { fakePolicyFilesystem, hostFilesystemOf } from '@momonga/testkit';
import { openZ3, resolveInstalledZ3, verifyPermissions } from '../src/index.ts';
import type { SecretLocation, VerificationReport, Z3Engine } from '../src/index.ts';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

export type Layout = { root: string; home: string; project: string; outside: string };

export const makeLayout = (): Layout => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-verify-')));
  fs.chmodSync(root, 0o700);
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = { root, home: path.join(root, 'home'), project: path.join(root, 'project'), outside: path.join(root, 'outside') };
  for (const dir of [layout.home, layout.project, layout.outside]) fs.mkdirSync(dir, { mode: 0o700 });
  return layout;
};

let engine: Z3Engine | undefined;

export const useZ3 = (): { engine: () => Z3Engine } => {
  beforeAll(async () => {
    engine = await openZ3({ entry: resolveInstalledZ3(import.meta.url) });
  });
  afterAll(async () => {
    await engine?.close();
    engine = undefined;
  });
  return { engine: () => engine as Z3Engine };
};

export const caseSensitiveFs = (): PolicyFilesystem => fakePolicyFilesystem({ overrides: { volumeProbe: () => false } });
export const caseInsensitiveFs = (): PolicyFilesystem => fakePolicyFilesystem({ overrides: { volumeProbe: () => true } });

export type RuleSpec = readonly [effect: RuleEffect, text: string];

export const rulesOf = (layout: Layout, specs: readonly RuleSpec[], origin: 'user' | 'project' = 'project'): PermissionRule[] =>
  specs.map(([effect, text]) => parseRule(text, { effect, origin, source: `${origin}-settings`, settingsRoot: layout.project, home: layout.home, cwd: layout.project }));

export const sshLocation = (layout: Layout): SecretLocation => ({ label: '~/.ssh', directory: path.join(layout.home, '.ssh'), accesses: ['read', 'write'] });

export type VerifyOptions = {
  mode?: PermissionMode;
  fileSystem?: PolicyFilesystem;
  secretLocations?: readonly SecretLocation[];
  budgetMs?: number;
  roots?: readonly string[];
};

export const verifyScenario = (api: Z3Engine['api'], layout: Layout, rules: readonly PermissionRule[], options: VerifyOptions = {}): Promise<VerificationReport> => {
  const fileSystem = options.fileSystem ?? caseSensitiveFs();
  const roots = options.roots ?? [layout.project];
  return verifyPermissions(api, {
    rules,
    roots,
    mode: options.mode ?? 'default',
    home: layout.home,
    cwd: layout.project,
    protectedSet: protectedSetFor(roots, fileSystem),
    fs: hostFilesystemOf(fileSystem),
    secretLocations: options.secretLocations ?? [sshLocation(layout)],
    exemptDirectory: null,
    enforcement: HOST_RULE_ENFORCEMENT,
    budgetMs: options.budgetMs ?? 120_000,
  });
};
