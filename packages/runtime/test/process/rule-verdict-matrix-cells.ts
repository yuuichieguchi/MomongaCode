import { describe, expect, it, vi } from 'vitest';
import { parseRule } from '@momonga/config';
import type { RuleEnforcement } from '@momonga/foundation';
import { PERMISSION_MODES } from '@momonga/protocol';
import type { PermissionMode } from '@momonga/protocol';
import { NEVER_CANCELLED } from '@momonga/testkit';
import { makeEnv } from '../worker/harness.ts';
import type { Env } from '../worker/harness.ts';

export const SOLVER_GUARD_MS = 60 * 60 * 1000;

const ENFORCEMENTS = ['exact-paths', 'seatbelt-profile'] as const satisfies readonly RuleEnforcement[];

const SEATBELT_ONLY_ON_MACOS = 'seatbelt-profile is the enforcement of the macOS sandbox; this host has no seatbelt';

const RULE_SETS = [
  { name: 'a deny of a system folder', rules: [{ text: 'Read(//etc/**)', effect: 'deny' }], verdict: 'proved', refutes: [] },
  { name: 'an allow of the whole home', rules: [{ text: 'Read(~/**)', effect: 'allow' }], verdict: 'refuted', refutes: ['secret-reach'] },
] as const;

export const cells = PERMISSION_MODES.flatMap((mode) => ENFORCEMENTS.flatMap((enforcement) => RULE_SETS.map((set) => ({ mode, enforcement, set }))));

const decide = async (env: Env, mode: PermissionMode, enforcement: RuleEnforcement, rules: readonly { text: string; effect: 'allow' | 'deny' }[]) => {
  const cwd = env.project;
  const parsed = rules.map((rule) => parseRule(rule.text, { effect: rule.effect, origin: 'user', source: `${env.home}/.momonga/settings.json`, settingsRoot: env.home, home: env.home, cwd } as never));
  const input = await env.ruleVerifier.inputOf({ unixSockets: { kind: 'limited', allowed: [] }, rules: parsed, roots: [cwd], mode, home: env.home, cwd, exemptDirectory: `${env.home}/.momonga/tmp/sessions/s1`, enforcement, secrets: [] }, NEVER_CANCELLED);
  return env.ruleVerifier.verify(input, NEVER_CANCELLED);
};

const matrixOf = (mode: PermissionMode, enforcement: RuleEnforcement): void => {
  vi.setConfig({ testTimeout: SOLVER_GUARD_MS });

  it.each(cells.filter((cell) => cell.enforcement === enforcement && cell.mode === mode))('$mode with $enforcement: $set.name is $set.verdict', async ({ mode, set }) => {
    const env = await makeEnv();
    const verdict = await decide(env, mode, enforcement, set.rules);
    expect(verdict.solver).toMatch(/^z3 [0-9a-f]{64}$/);
    expect(verdict.verdict).toBe(set.verdict);
    expect(verdict.refuted.map((entry) => entry.property)).toEqual(expect.arrayContaining([...set.refutes]));
  });
};

export const ruleVerdictMatrixOf = (mode: PermissionMode): void => {
  describe(`every permission mode with exact-paths, through the decider of the product: ${mode}`, () => matrixOf(mode, 'exact-paths'));

  describe.skipIf(process.platform !== 'darwin')(`every permission mode with seatbelt-profile, through the decider of the product: ${mode} (skipped elsewhere: ${SEATBELT_ONLY_ON_MACOS})`, () => matrixOf(mode, 'seatbelt-profile'));
};
