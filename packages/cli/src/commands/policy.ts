import path from 'node:path';
import { loadSettings } from '@momonga/config';
import { canonicalDirectory, canonicalPath, protectedSetFor } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { PermissionMode } from '@momonga/protocol';
import { connectRuntime } from '../run/open-session.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import type { PolicyVerifyHost } from '../verify/host.ts';

export const VERIFY_QUERY_TIMEOUT_MS = 10_000;

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
  try {
    trusted = (await runtime.trust(ports.cwd)).decision === 'trusted';
  } finally {
    await runtime.close();
  }
  const loaded = await loadSettings({ home: ports.home, projectDir: ports.cwd, cli: {}, trust: { isTrusted: () => trusted } });
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
      rules: loaded.rules,
      roots,
      mode,
      home,
      cwd: ports.cwd,
      protectedSet: protectedSetFor(roots, fs),
      fs,
      secretLocations,
      exemptDirectory: null,
      timeoutMs: VERIFY_QUERY_TIMEOUT_MS,
    });
    ports.stdout.write(`${options.json ? JSON.stringify(report) : verifier.formatReport(report)}\n`);
    for (const warning of loaded.warnings) ports.stderr.write(`warning: ${warning}\n`);
    return report.exitCode;
  } finally {
    await engine.close();
  }
};
