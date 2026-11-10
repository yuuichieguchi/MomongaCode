import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakePolicyFilesystem } from '@momonga/testkit';
import { ConfigError, parseRule } from '@momonga/config';
import type { PermissionRule } from '@momonga/config';
import { computeFileRules, decide } from '@momonga/policy';
import type { DecideInput } from '@momonga/policy';
import * as runtime from '@momonga/runtime';
import { buildSeatbeltProfile } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { createSession, makeDir, makeLogger, makeTempHome, openStore } from './helpers.ts';

const RUNNING_AS_ROOT = process.getuid?.() === 0;

const setup = async () => {
  const temp = await makeTempHome();
  const { store, clock } = openStore(temp);
  const states = runtime.createSessionStates({ clock, store, logger: makeLogger(), releaseScratch: () => undefined });
  const policyFor = runtime.createPolicyFor({ paths: temp.paths, home: temp.home, sessionStates: states, fs: fakePolicyFilesystem(), ruleEnforcement: 'exact-paths' });
  return { temp, store, policyFor };
};

const ruleOf = (cwd: string, home: string, text: string): PermissionRule =>
  parseRule(text, { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: cwd, home, cwd });

type Built = { roots: readonly string[]; tmpDir: string; sandboxPolicy: SandboxPolicy & { fileRules: ReturnType<typeof computeFileRules> } };

describe('createPolicyFor roots and the file rules', () => {
  it('computes the file rules over policy.roots, which never contain the tmp dir', async () => {
    const { temp, store, policyFor } = await setup();
    const extra = makeDir(temp.root, 'extra');
    const session = createSession(store, temp.project, { additionalDirectories: [extra] });
    const rules = [ruleOf(temp.project, temp.home, 'Read(.env)')];
    const policy = (await policyFor(session, { env: {}, rules } as Parameters<typeof policyFor>[1])) as unknown as Built;
    expect(policy.roots).toEqual([temp.project, extra]);
    expect(policy.roots).not.toContain(policy.tmpDir);
    expect(policy.sandboxPolicy.fileRules).toEqual(computeFileRules(rules, [temp.project, extra], policy.tmpDir, 'exact-paths'));
  });

  it('lets decide and the profile read the same entries for a rule with an additional directory', async () => {
    const { temp, store, policyFor } = await setup();
    const extra = makeDir(temp.root, 'extra');
    const session = createSession(store, temp.project, { additionalDirectories: [extra] });
    const rules = [ruleOf(temp.project, temp.home, 'Read(.env)')];
    const policy = (await policyFor(session, { env: {}, rules } as Parameters<typeof policyFor>[1])) as unknown as Built;
    const target = path.join(extra, '.env');
    fs.writeFileSync(target, 'SECRET');
    const decision = decide({
      tool: { name: 'Read', kind: 'read', sideEffect: 'read_only' },
      subject: { kind: 'path', tool: 'Read', paths: [target], access: 'read' },
      mode: 'bypassPermissions',
      rules,
      roots: [...policy.roots, policy.tmpDir],
      home: temp.home,
      cwd: temp.project,
      fileRules: policy.sandboxPolicy.fileRules,
      protectedSet: policy.sandboxPolicy.protectedSet,
      fs: fakePolicyFilesystem(),
      searchPath: undefined,
      isWritable: () => false,
    } as DecideInput);
    expect(decision).toMatchObject({ kind: 'deny', source: 'rule' });
    const profile = buildSeatbeltProfile(policy.sandboxPolicy, { tmpDir: policy.tmpDir });
    const readDenies = Object.entries(profile.params).filter(([name]) => name.startsWith('FILE_DENY_READ_'));
    expect(readDenies.length).toBeGreaterThan(0);
    expect(readDenies.some(([, value]) => value.includes(extra) || value.includes(extra.replace(/[.*+?()[\]{}|^$\\]/g, '\\$&')))).toBe(true);
    expect(readDenies.some(([, value]) => value.includes(temp.project) || value.includes(temp.project.replace(/[.*+?()[\]{}|^$\\]/g, '\\$&')))).toBe(true);
  });

  it.skipIf(RUNNING_AS_ROOT)('fails policyFor for an unresolvable deny prefix, so decide is never reached', async () => {
    const { temp, store, policyFor } = await setup();
    const session = createSession(store, temp.project);
    const locked = path.join(temp.root, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      await expect(policyFor(session, { env: {}, rules: [ruleOf(temp.project, temp.home, `Read(/${locked}/x/**)`)] } as Parameters<typeof policyFor>[1])).rejects.toBeInstanceOf(ConfigError);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});

describe('createPolicyFor with a cwd spelled through a symlink (pin)', () => {
  it('gives canonical roots to policy.roots and to the file rules', async () => {
    const { temp, store, policyFor } = await setup();
    const link = path.join(temp.root, 'project-link');
    fs.symlinkSync(temp.project, link);
    const session = createSession(store, link);
    const rules = [ruleOf(link, temp.home, 'Read(.env)')];
    const policy = (await policyFor(session, { env: {}, rules } as Parameters<typeof policyFor>[1])) as unknown as Built;
    expect(policy.roots).toEqual([fs.realpathSync(temp.project)]);
    expect(policy.sandboxPolicy.fileRules.fingerprint).toBe(computeFileRules(rules, policy.roots, policy.tmpDir, 'exact-paths').fingerprint);
    expect(policy.sandboxPolicy.fileRules.entries.map((entry) => entry.anchorDirectory)).toEqual([fs.realpathSync(temp.project)]);
  });
});
