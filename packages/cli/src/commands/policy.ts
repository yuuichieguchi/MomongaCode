import path from 'node:path';
import { loadSettings, parseGovernanceRule } from '@momonga/config';
import { canonicalDirectory, canonicalPath, protectedSetFor, ruleEnforcementOf } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { PermissionMode, PolicyGovernanceResponse } from '@momonga/protocol';
import { formatGovernanceVerification } from '../rule/format.ts';
import { connectRuntime } from '../run/open-session.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { escapedLines } from '../terminal-writer.ts';
import type { PolicyVerifyHost } from '../verify/host.ts';

export const policyWarningsText = (warnings: readonly string[]): string => `${escapedLines(warnings.map((warning) => `warning: ${warning}`))}\n`;

export const VERIFY_BUDGET_MS = 60_000;

export type PolicyVerifyOptions = { json: boolean; mode?: PermissionMode; secrets: readonly string[] };

export class PolicyVerifyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyVerifyInputError';
  }
}

const rootsOf = (cwd: string, additional: readonly string[]): string[] =>
  [cwd, ...additional].map((root) => {
    const resolved = canonicalDirectory(root);
    if (!resolved.ok) throw new PolicyVerifyInputError(`the folder ${root} ${resolved.reason}`);
    return resolved.path;
  });

const secretPathOf = (home: string, text: string): string => {
  if (text === '~' || text.startsWith('~/')) return path.join(home, text.slice(1));
  if (!path.isAbsolute(text)) throw new PolicyVerifyInputError(`--secret ${JSON.stringify(text)} must be an absolute path or start with ~/`);
  return text;
};

export const policyVerify = async (ports: CliPorts, paths: MomongaPaths, host: PolicyVerifyHost, options: PolicyVerifyOptions): Promise<number> => {
  await ensureDaemon(ports, paths);
  const runtime = connectRuntime(paths);
  let trusted: boolean;
  let governance: PolicyGovernanceResponse;
  try {
    trusted = (await runtime.trust(ports.cwd)).decision === 'trusted';
    governance = await runtime.policyGovernance(ports.cwd);
  } finally {
    await runtime.close();
  }
  const loaded = await loadSettings({ home: ports.home, projectDir: ports.cwd, cli: {}, trust: { isTrusted: () => trusted } });
  const governanceRules = governance.rules.map((entry) => parseGovernanceRule(entry, { home: ports.home, project: ports.cwd }));
  const roots = rootsOf(ports.cwd, loaded.settings.permissions.additionalDirectories);
  const mode = options.mode ?? loaded.settings.permissions.defaultMode ?? 'default';
  const verifier = await host.loadVerifier();
  const fs = await host.loadPolicyFilesystem();
  const home = canonicalPath(ports.home);
  const secretLocations = verifier.secretLocationsOf(
    home,
    paths,
    options.secrets.map((text) => secretPathOf(home, text)),
  );
  const engine = await host.openSolver(verifier);
  try {
    const report = await verifier.verifyPermissions(engine.api, {
      rules: [...loaded.rules, ...governanceRules],
      roots,
      mode,
      home,
      cwd: ports.cwd,
      protectedSet: protectedSetFor(roots, fs),
      fs,
      secretLocations,
      exemptDirectory: null,
      enforcement: ruleEnforcementOf(loaded.settings.sandbox),
      budgetMs: VERIFY_BUDGET_MS,
    });
    const hasGovernance = governance.rules.length > 0 || governance.textOnly.length > 0;
    ports.stdout.write(
      options.json
        ? `${JSON.stringify(hasGovernance ? { ...report, governance } : report)}\n`
        : `${verifier.formatReport(report)}\n${hasGovernance ? `${formatGovernanceVerification(governance, report.exitCode === 0)}\n` : ''}`,
    );
    if (loaded.warnings.length > 0) ports.stderr.write(policyWarningsText(loaded.warnings));
    return report.exitCode;
  } finally {
    await engine.close();
  }
};
