import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakePolicyFilesystem } from '@momonga/testkit';
import { ConfigError, loadSettings, parseRule } from '@momonga/config';
import type { PermissionRule } from '@momonga/config';
import { FileRuleError } from '@momonga/foundation';
import { computeFileRules } from '@momonga/policy';
import * as runtime from '@momonga/runtime';
import { createSession, makeLogger, makeTempHome, openStore } from './helpers.ts';

const RUNNING_AS_ROOT = process.getuid?.() === 0;

const setup = async () => {
  const temp = await makeTempHome();
  const { store, clock } = openStore(temp);
  const states = runtime.createSessionStates({ clock, store, logger: makeLogger() });
  const policyFor = runtime.createPolicyFor({ paths: temp.paths, home: temp.home, sessionStates: states, fs: fakePolicyFilesystem(), ruleEnforcement: 'exact-paths' });
  return { temp, store, policyFor };
};

const env = (): Readonly<Record<string, string>> => Object.freeze({ PLAIN: '1' });

const ruleOf = (cwd: string, home: string, text: string): PermissionRule =>
  parseRule(text, { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: cwd, home, cwd });

type PolicyWithFileRules = { sandboxPolicy: { fileRules: ReturnType<typeof computeFileRules> }; roots: readonly string[]; tmpDir: string };

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );

describe('createPolicyFor builds the file rules of the batch', () => {
  it('gives fileRules equal to computeFileRules over the rules, the roots and the tmp dir', async () => {
    const { temp, store, policyFor } = await setup();
    const session = createSession(store, temp.project);
    const rules = [ruleOf(temp.project, temp.home, 'Read(.env)'), ruleOf(temp.project, temp.home, 'Write(*.pem)')];
    const policy = (await policyFor(session, { env: env(), rules } as Parameters<typeof policyFor>[1])) as unknown as PolicyWithFileRules;
    expect(policy.sandboxPolicy.fileRules).toEqual(computeFileRules(rules, policy.roots, policy.tmpDir));
    expect(policy.sandboxPolicy.fileRules.entries.length).toBeGreaterThan(0);
  });

  it('builds a different set for different rules on every call', async () => {
    const { temp, store, policyFor } = await setup();
    const session = createSession(store, temp.project);
    const first = (await policyFor(session, { env: env(), rules: [ruleOf(temp.project, temp.home, 'Read(.env)')] } as Parameters<typeof policyFor>[1])) as unknown as PolicyWithFileRules;
    const second = (await policyFor(session, { env: env(), rules: [ruleOf(temp.project, temp.home, 'Read(.envrc)')] } as Parameters<typeof policyFor>[1])) as unknown as PolicyWithFileRules;
    expect(second.sandboxPolicy.fileRules.fingerprint).not.toBe(first.sandboxPolicy.fileRules.fingerprint);
  });

  it.skipIf(RUNNING_AS_ROOT)('rejects an unresolvable deny prefix with a ConfigError caused by a FileRuleError', async () => {
    const { temp, store, policyFor } = await setup();
    const session = createSession(store, temp.project);
    const locked = path.join(temp.root, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    const error = await rejectionOf(policyFor(session, { env: env(), rules: [ruleOf(temp.project, temp.home, `Read(/${locked}/x/**)`)] } as Parameters<typeof policyFor>[1]));
    fs.chmodSync(locked, 0o700);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).cause).toBeInstanceOf(FileRuleError);
    expect(((error as Error).cause as FileRuleError).code).toBe('unresolvable_prefix');
  });

  it.each([
    ['trusted', true],
    ['untrusted', false],
  ])('carries a project deny rule only for a %s folder', async (_label, trusted) => {
    const { temp, store, policyFor } = await setup();
    fs.mkdirSync(path.join(temp.project, '.momonga'), { recursive: true });
    fs.writeFileSync(path.join(temp.project, '.momonga', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(.env)'] } }));
    const loaded = await loadSettings({ home: temp.home, projectDir: temp.project, cli: {}, trust: { isTrusted: () => trusted } });
    const session = createSession(store, temp.project);
    const policy = (await policyFor(session, { env: env(), rules: loaded.rules } as Parameters<typeof policyFor>[1])) as unknown as PolicyWithFileRules;
    const projectEntries = policy.sandboxPolicy.fileRules.entries.filter((entry) => entry.provenance.layer === 'project');
    expect(projectEntries.length > 0).toBe(trusted);
  });
});
