import { parseRule } from '@momonga/config';
import type { MandateProfileSettings, PermissionRule } from '@momonga/config';
import { hostPaths, sessionRootsOf, verdictKey } from '@momonga/foundation';
import type { RuleEnforcement } from '@momonga/foundation';
import { isFinalRuleVerdict } from '@momonga/protocol';
import type { PermissionMode, PolicyVerifyResponse, RuleVerdict } from '@momonga/protocol';
import type { OperationCatalogueFacts } from '@momonga/tools';
import type { RuleVerifierPort } from '../ports.ts';
import { invalidRequest } from '../service/errors.ts';

export type FolderVerifyRequest = { cwd: string; mode?: PermissionMode; secrets: readonly string[]; mandate?: string };

export type PolicyVerification = (request: FolderVerifyRequest, signal: AbortSignal) => Promise<PolicyVerifyResponse>;

export type FolderPolicyFacts = { rules: readonly PermissionRule[]; defaultMode?: PermissionMode; additionalDirectories: readonly string[]; enforcement: RuleEnforcement };

export type FolderPolicySources = {
  verifier: RuleVerifierPort;
  ruleVerdicts: { put(fingerprint: string, verdict: RuleVerdict): void };
  home: string;
  folder: (cwd: string, signal: AbortSignal) => Promise<FolderPolicyFacts>;
  mandates: (signal: AbortSignal) => Promise<Readonly<Record<string, MandateProfileSettings>> | undefined>;
  catalogue: () => OperationCatalogueFacts;
};

const MANDATE_EFFECTS = ['deny', 'ask', 'allow'] as const;

const mandateRulesOf = (name: string, mandate: MandateProfileSettings, context: { home: string; cwd: string }): PermissionRule[] =>
  MANDATE_EFFECTS.flatMap((effect) => (mandate[effect] ?? []).map((text) => parseRule(text, { effect, origin: 'cli', source: `the mandate ${name}`, settingsRoot: context.cwd, ...context })));

export const folderPolicyVerification =
  (sources: FolderPolicySources): PolicyVerification =>
  async (request, signal) => {
    const paths = hostPaths(signal);
    const folder = await paths.canonicalDirectory(request.cwd);
    if (!folder.ok) throw invalidRequest(`the folder ${request.cwd} ${folder.reason}`, 'project');
    const cwd = folder.path;
    const facts = await sources.folder(cwd, signal);
    const roots = await sessionRootsOf(cwd, facts.additionalDirectories, paths);
    if (!roots.ok) throw invalidRequest(`the folder ${roots.root} ${roots.reason}`, 'project');
    const context = { home: sources.home, cwd };
    const mandate = request.mandate === undefined ? undefined : { name: request.mandate, profile: (await sources.mandates(signal))?.[request.mandate] };
    if (mandate !== undefined && mandate.profile === undefined) throw invalidRequest(`no mandate named ${JSON.stringify(mandate.name)} is declared in the user settings`, 'mandate');
    const input = await sources.verifier.inputOf(
      {
        rules: mandate?.profile === undefined ? facts.rules : [...facts.rules, ...mandateRulesOf(mandate.name, mandate.profile, context)],
        roots: roots.roots,
        mode: request.mode ?? facts.defaultMode ?? 'manual',
        home: sources.home,
        cwd,
        exemptDirectory: null,
        enforcement: facts.enforcement,
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
