import { parseRule } from '@momonga/config';
import type { MandateProfileSettings, PermissionRule } from '@momonga/config';
import { hostPaths, sessionRootsOf, verdictKey } from '@momonga/foundation';
import type { RuleEnforcement, UnixSocketPolicy } from '@momonga/foundation';
import { DEFAULT_PERMISSION_MODE, isFinalRuleVerdict } from '@momonga/protocol';
import type { Mandate, PermissionMode, PolicyVerifyResponse, RuleVerdict } from '@momonga/protocol';
import type { OperationCatalogueFacts } from '@momonga/tools';
import type { RuleVerifierPort } from '../ports.ts';
import { invalidRequest } from '../service/errors.ts';
import { delegationOf } from '../worker/held-calls.ts';
import { verdictOfKey, verdictOrUnverified } from '../worker/rule-verdict.ts';
import type { VerdictCache } from '../worker/rule-verdict.ts';
import { sessionScratchRoleIn } from './session-scratch-role.ts';

export type FolderVerifyRequest = { cwd: string; mode?: PermissionMode; secrets: readonly string[]; mandate?: string };

export type PolicyVerification = (request: FolderVerifyRequest, signal: AbortSignal) => Promise<PolicyVerifyResponse>;

export type FolderPolicyFacts = { rules: readonly PermissionRule[]; defaultMode?: PermissionMode; additionalDirectories: readonly string[]; enforcement: RuleEnforcement; unixSockets: UnixSocketPolicy };

export type FolderPolicySources = {
  verifier: RuleVerifierPort;
  ruleVerdicts: { put(fingerprint: string, verdict: RuleVerdict): void };
  home: string;
  sessionsRoot: string;
  folder: (cwd: string, signal: AbortSignal) => Promise<FolderPolicyFacts>;
  mandates: (signal: AbortSignal) => Promise<Readonly<Record<string, MandateProfileSettings>> | undefined>;
  catalogue: () => OperationCatalogueFacts;
};

const MANDATE_EFFECTS = ['deny', 'ask', 'allow'] as const;

const mandateRulesOf = (name: string, mandate: MandateProfileSettings, context: { home: string; cwd: string }): PermissionRule[] =>
  MANDATE_EFFECTS.flatMap((effect) => (mandate[effect] ?? []).map((text) => parseRule(text, { effect, origin: 'cli', source: `the mandate ${name}`, settingsRoot: context.cwd, ...context })));

type FolderPlace = { cwd: string; facts: FolderPolicyFacts; roots: readonly string[] };

const folderPlaceOf = async (sources: Pick<FolderPolicySources, 'folder'>, requested: string, signal: AbortSignal): Promise<FolderPlace> => {
  const paths = hostPaths(signal);
  const folder = await paths.canonicalDirectory(requested);
  if (!folder.ok) throw invalidRequest(`the folder ${requested} ${folder.reason}`, 'project');
  const cwd = folder.path;
  const facts = await sources.folder(cwd, signal);
  const roots = await sessionRootsOf(cwd, facts.additionalDirectories, paths);
  if (!roots.ok) throw invalidRequest(`the folder ${roots.root} ${roots.reason}`, 'project');
  return { cwd, facts, roots: roots.roots };
};

export const folderPolicyVerification =
  (sources: FolderPolicySources): PolicyVerification =>
  async (request, signal) => {
    const { cwd, facts, roots } = await folderPlaceOf(sources, request.cwd, signal);
    const context = { home: sources.home, cwd };
    const mandate = request.mandate === undefined ? undefined : { name: request.mandate, profile: (await sources.mandates(signal))?.[request.mandate] };
    if (mandate !== undefined && mandate.profile === undefined) throw invalidRequest(`no mandate named ${JSON.stringify(mandate.name)} is declared in the user settings`, 'mandate');
    const input = await sources.verifier.inputOf(
      {
        rules: mandate?.profile === undefined ? facts.rules : [...facts.rules, ...mandateRulesOf(mandate.name, mandate.profile, context)],
        roots,
        mode: request.mode ?? facts.defaultMode ?? DEFAULT_PERMISSION_MODE,
        home: sources.home,
        cwd,
        exemptDirectory: sessionScratchRoleIn(sources.sessionsRoot),
        enforcement: facts.enforcement,
        unixSockets: facts.unixSockets,
        secrets: request.secrets,
        ...(mandate === undefined ? {} : { mandateChecks: sources.catalogue() }),
      },
      signal,
    );
    const fingerprint = verdictKey(input, await sources.verifier.solverVersion());
    const verification = await sources.verifier.report(input, signal);
    const stored = mandate === undefined && isFinalRuleVerdict(verification.verdict);
    if (stored) sources.ruleVerdicts.put(fingerprint, verification.verdict);
    const { exitCode } = verification.findings;
    if (typeof exitCode !== 'number') throw new Error('the verification gave findings without an exit code');
    return { fingerprint, stored, exitCode, text: verification.report, findings: verification.findings };
  };

export type MandateRunRequest = { cwd: string; mode: PermissionMode; mandate: Mandate };

export type MandateRunVerification = (request: MandateRunRequest, signal: AbortSignal) => Promise<RuleVerdict>;

export type MandateRunSources = Omit<FolderPolicySources, 'mandates' | 'ruleVerdicts'> & {
  ruleVerdicts: VerdictCache;
  retrySignal: AbortSignal;
  onRetryFailure: (error: unknown) => void;
};

export const mandateRunVerification =
  (sources: MandateRunSources): MandateRunVerification =>
  async ({ cwd: requested, mode, mandate }, signal) => {
    const { cwd, facts, roots } = await folderPlaceOf(sources, requested, signal);
    const catalogue = sources.catalogue();
    const { delegation } = delegationOf({ mandate }, { home: sources.home, cwd }, catalogue);
    const rules = [...facts.rules, ...(delegation?.rules ?? [])];
    const solver = await sources.verifier.solverVersion();
    if (!rules.some((rule) => rule.effect === 'allow')) return { verdict: 'not-needed', solver, refuted: [], unknown: [], notProved: [] };
    const input = await sources.verifier.inputOf(
      {
        rules,
        roots,
        mode,
        home: sources.home,
        cwd,
        exemptDirectory: sessionScratchRoleIn(sources.sessionsRoot),
        enforcement: facts.enforcement,
        unixSockets: facts.unixSockets,
        secrets: [],
        mandateChecks: catalogue,
      },
      signal,
    );
    return verdictOfKey({
      verifier: sources.verifier,
      cache: sources.ruleVerdicts,
      fingerprint: verdictKey(input, solver),
      solver,
      signal,
      verify: () => verdictOrUnverified(sources.verifier.verify(input, signal), solver),
      retry: () => sources.verifier.verify(input, sources.retrySignal),
      onRetryFailure: sources.onRetryFailure,
    });
  };
