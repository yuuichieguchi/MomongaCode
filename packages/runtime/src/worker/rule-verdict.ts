import type { PermissionRule } from '@momonga/config';
import { settledOrAborted, unixSocketPolicyOf, verdictKey } from '@momonga/foundation';
import type { RuleEnforcement, UnixSocketPolicy } from '@momonga/foundation';
import { POLICY_REFUTED_CODE, POLICY_VERDICT_NOTICE_CODE, isFinalRuleVerdict, policyRefutedMessage, policyVerdictNotice, refusingRefutations } from '@momonga/protocol';
import type { PinnedRuleVerdict, RuleVerdict, RunEventPayload, RunState } from '@momonga/protocol';
import type { RunError } from '@momonga/store';
import { permissionRulesFor } from '../governance/rules.ts';
import type { RuleVerifierPort, ToolEnv } from '../ports.ts';
import { RuleVerificationFailure } from '../process/rule-verifier-thread-client.ts';
import { sessionScratchRoleOf } from '../process/session-scratch-role.ts';
import type { ClaimControl } from './claim-control.ts';
import type { Delegation } from './held-calls.ts';
import type { HeldSession } from './known.ts';
import { holdSandbox } from './held-sandbox.ts';
import type { WorkerOptions } from './types.ts';

export type RuleVerdictSources = { options: Pick<WorkerOptions, 'store' | 'home' | 'ruleVerifier' | 'verificationStop'>; control: Pick<ClaimControl, 'signal' | 'recordingRaised' | 'fail'> };

export type RuleSetFacts = { rules: readonly PermissionRule[]; roots: readonly string[]; exemptDirectory: string; enforcement: RuleEnforcement; unixSockets: UnixSocketPolicy };

export const runRulesFor = async (
  options: Parameters<typeof permissionRulesFor>[0],
  session: HeldSession,
  delegation: Pick<Delegation, 'rules'> | undefined,
  signal: AbortSignal,
): Promise<PermissionRule[]> => [...(await permissionRulesFor(options, session, signal)), ...(delegation?.rules ?? [])];

type Undecided = { verdict: RuleVerdict; retry: Promise<void> | undefined };

const undecidedByVerifier = new WeakMap<RuleVerifierPort, Map<string, Undecided>>();

const undecidedOf = (verifier: RuleVerifierPort): Map<string, Undecided> => {
  const known = undecidedByVerifier.get(verifier);
  if (known !== undefined) return known;
  const fresh = new Map<string, Undecided>();
  undecidedByVerifier.set(verifier, fresh);
  return fresh;
};

const NOT_NEEDED = { verdict: 'not-needed', refuted: [], unknown: [], notProved: [] } as const satisfies Omit<RuleVerdict, 'solver'>;

const WHOLE_VERIFICATION = 'verification';

const unverified = (solver: string, failure: RuleVerificationFailure): RuleVerdict => ({ verdict: 'unknown', solver, refuted: [], unknown: [{ property: WHOLE_VERIFICATION, reason: failure.message }], notProved: [] });

export const verdictOrUnverified = async (verifying: Promise<RuleVerdict>, solver: string): Promise<RuleVerdict> => {
  try {
    return await verifying;
  } catch (error) {
    if (error instanceof RuleVerificationFailure) return unverified(solver, error);
    throw error;
  }
};

export const ruleVerdictFor = async ({ options, control }: RuleVerdictSources, session: HeldSession, facts: RuleSetFacts): Promise<PinnedRuleVerdict> => {
  const verifier: RuleVerifierPort = options.ruleVerifier;
  const input = await verifier.inputOf(
    { rules: facts.rules, roots: facts.roots, mode: session.permissionMode, home: options.home, cwd: session.cwd, exemptDirectory: sessionScratchRoleOf(facts.exemptDirectory), enforcement: facts.enforcement, secrets: [], unixSockets: facts.unixSockets },
    control.signal,
  );
  const solver = await verifier.solverVersion();
  const fingerprint = verdictKey(input, solver);
  if (!(await verifier.needsVerdict(input))) return { fingerprint, solver, ...NOT_NEEDED };
  const verdict = await control.recordingRaised(verdictOfKey({
    verifier,
    cache: options.store.ruleVerdicts,
    fingerprint,
    solver,
    signal: control.signal,
    verify: () => verdictOrUnverified(verifier.verify(input, options.verificationStop), solver),
    retry: () => verifier.verify(input, options.verificationStop),
    onRetryFailure: (error) => {
      if (!control.signal.aborted) control.fail(error);
    },
  }));
  return { fingerprint, ...verdict };
};

export type VerdictCache = { get(fingerprint: string): { verdict: RuleVerdict } | undefined; put(fingerprint: string, verdict: RuleVerdict): void };

export type KeyedVerification = {
  verifier: RuleVerifierPort;
  cache: VerdictCache;
  fingerprint: string;
  solver: string;
  signal: AbortSignal;
  verify: () => Promise<RuleVerdict>;
  retry: () => Promise<RuleVerdict>;
  onRetryFailure: (error: unknown) => void;
};

export const verdictOfKey = async ({ verifier, cache, fingerprint, solver, signal, verify, retry, onRetryFailure }: KeyedVerification): Promise<RuleVerdict> => {
  const stored = cache.get(fingerprint);
  if (stored !== undefined) return stored.verdict;
  const undecided = undecidedOf(verifier);
  const settle = (verdict: RuleVerdict): void => {
    if (isFinalRuleVerdict(verdict)) {
      cache.put(fingerprint, verdict);
      undecided.delete(fingerprint);
    } else {
      undecided.set(fingerprint, { verdict, retry: undefined });
    }
  };
  const earlier = undecided.get(fingerprint);
  if (earlier === undefined) return settledOrAborted(verify().then((verdict) => (settle(verdict), verdict)), signal);
  earlier.retry ??= verdictOrUnverified(retry(), solver).then(settle, (error: unknown) => {
    earlier.retry = undefined;
    onRetryFailure(error);
  });
  return earlier.verdict;
};

export type StartVerdictSources = RuleVerdictSources & {
  options: Pick<WorkerOptions, 'store' | 'home' | 'ruleVerifier' | 'tools' | 'settings' | 'clock' | 'verificationStop'>;
  env: ToolEnv;
  readableDirectories: readonly string[];
  delegation: Pick<Delegation, 'rules'> | undefined;
};

export const ruleVerdictAtStart = async (sources: StartVerdictSources, session: HeldSession): Promise<PinnedRuleVerdict> => {
  const { options, control } = sources;
  const held = await holdSandbox(options.tools.sandboxes, control.signal);
  try {
    const rules = await runRulesFor(options, session, sources.delegation, control.signal);
    const policy = await options.tools.policyFor(session, { env: sources.env, rules, readableDirectories: sources.readableDirectories, ruleEnforcement: held.ruleEnforcement, signal: control.signal, discoverGitConfig: true });
    return await ruleVerdictFor(sources, session, { rules, roots: policy.roots, exemptDirectory: policy.tmpDir, enforcement: held.ruleEnforcement, unixSockets: unixSocketPolicyOf(held.sandbox.kind, policy.sandboxPolicy.unixSocketAllow ?? []) });
  } finally {
    held.done();
  }
};

export const mandateRefusal = async (
  options: Pick<WorkerOptions, 'mandateVerification'>,
  session: HeldSession,
  delegation: Pick<Delegation, 'scope'> | undefined,
  signal: AbortSignal,
): Promise<RunError | undefined> => {
  if (delegation === undefined) return undefined;
  const verdict = await options.mandateVerification({ cwd: session.cwd, mode: session.permissionMode, mandate: { scope: delegation.scope } }, signal);
  return refusingRefutations(verdict).length > 0 ? { code: POLICY_REFUTED_CODE, message: policyRefutedMessage(verdict) } : undefined;
};

export const policyRefusal = (verdict: PinnedRuleVerdict): RunError | undefined =>
  refusingRefutations(verdict).length > 0 ? { code: POLICY_REFUTED_CODE, message: policyRefutedMessage(verdict) } : undefined;

const SETTLED_WITHOUT_FINDING: readonly RuleVerdict['verdict'][] = ['proved', 'not-needed'];

const noticeLevelOf = (verdict: PinnedRuleVerdict): 'info' | 'warning' | 'error' => {
  if (refusingRefutations(verdict).length > 0) return 'error';
  return SETTLED_WITHOUT_FINDING.some((kind) => kind === verdict.verdict) && verdict.refuted.length === 0 ? 'info' : 'warning';
};

export const laterVerdictNotice = (state: Pick<RunState, 'notes'>, pinnedFingerprint: string | undefined, verdict: PinnedRuleVerdict): RunEventPayload[] => {
  if (verdict.fingerprint === pinnedFingerprint) return [];
  const message = policyVerdictNotice(verdict);
  if (state.notes.some((note) => note.code === POLICY_VERDICT_NOTICE_CODE && note.message === message)) return [];
  return [{ type: 'notice', level: noticeLevelOf(verdict), code: POLICY_VERDICT_NOTICE_CODE, message }];
};
