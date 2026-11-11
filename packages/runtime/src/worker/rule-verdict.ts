import type { PermissionRule } from '@momonga/config';
import { ruleFingerprint } from '@momonga/foundation';
import type { RuleEnforcement } from '@momonga/foundation';
import { POLICY_REFUTED_CODE, POLICY_VERDICT_NOTICE_CODE, policyRefutedMessage, policyVerdictNotice } from '@momonga/protocol';
import type { PinnedRuleVerdict, RunEventPayload, RunState } from '@momonga/protocol';
import type { RunError } from '@momonga/store';
import { permissionRulesFor } from '../governance/rules.ts';
import type { RuleVerifierPort, ToolEnv } from '../ports.ts';
import type { ClaimControl } from './claim-control.ts';
import type { HeldSession } from './known.ts';
import { holdSandbox } from './held-sandbox.ts';
import type { WorkerOptions } from './types.ts';

export { ruleFingerprint };

export type RuleVerdictSources = { options: Pick<WorkerOptions, 'store' | 'home' | 'ruleVerifier'>; control: Pick<ClaimControl, 'signal' | 'recordingRaised'> };

export type RuleSetFacts = { rules: readonly PermissionRule[]; roots: readonly string[]; enforcement: RuleEnforcement };

export const ruleVerdictFor = async ({ options, control }: RuleVerdictSources, session: HeldSession, facts: RuleSetFacts): Promise<PinnedRuleVerdict> => {
  const verifier: RuleVerifierPort = options.ruleVerifier;
  const input = await verifier.inputOf({ rules: facts.rules, roots: facts.roots, mode: session.permissionMode, home: options.home, cwd: session.cwd, enforcement: facts.enforcement }, control.signal);
  const fingerprint = ruleFingerprint({ input, solverVersion: await verifier.solverVersion() });
  const stored = options.store.ruleVerdicts.get(fingerprint);
  if (stored !== undefined) return { fingerprint, ...stored.verdict };
  const verdict = await control.recordingRaised(verifier.verify(input, control.signal));
  options.store.ruleVerdicts.put(fingerprint, verdict);
  return { fingerprint, ...verdict };
};

export type StartVerdictSources = RuleVerdictSources & {
  options: Pick<WorkerOptions, 'store' | 'home' | 'ruleVerifier' | 'tools' | 'settings' | 'clock'>;
  env: ToolEnv;
  readableDirectories: readonly string[];
};

export const ruleVerdictAtStart = async (sources: StartVerdictSources, session: HeldSession): Promise<PinnedRuleVerdict> => {
  const { options, control } = sources;
  const held = await holdSandbox(options.tools.sandboxes, control.signal);
  try {
    const rules = await permissionRulesFor(options, session);
    const policy = await options.tools.policyFor(session, { env: sources.env, rules, readableDirectories: sources.readableDirectories, ruleEnforcement: held.ruleEnforcement, signal: control.signal });
    return await ruleVerdictFor(sources, session, { rules, roots: policy.roots, enforcement: held.ruleEnforcement });
  } finally {
    held.done();
  }
};

export const policyRefusal = (verdict: PinnedRuleVerdict): RunError | undefined =>
  verdict.verdict === 'refuted' ? { code: POLICY_REFUTED_CODE, message: policyRefutedMessage(verdict) } : undefined;

const NOTICE_LEVELS = { proved: 'info', unknown: 'warning', refuted: 'error' } as const;

export const laterVerdictNotice = (state: Pick<RunState, 'notes'>, pinnedFingerprint: string | undefined, verdict: PinnedRuleVerdict): RunEventPayload[] => {
  if (verdict.fingerprint === pinnedFingerprint) return [];
  if (state.notes.some((note) => note.code === POLICY_VERDICT_NOTICE_CODE && note.message.includes(verdict.fingerprint))) return [];
  return [{ type: 'notice', level: NOTICE_LEVELS[verdict.verdict], code: POLICY_VERDICT_NOTICE_CODE, message: policyVerdictNotice(verdict) }];
};
