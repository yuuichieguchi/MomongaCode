import path from 'node:path';
import type { MomongaPaths } from '@momonga/foundation';
import type { PermissionMode } from '@momonga/protocol';
import { formatGovernanceVerification } from '../rule/format.ts';
import { connectRuntime } from '../run/open-session.ts';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';

export type PolicyVerifyOptions = { json: boolean; mode?: PermissionMode; secrets: readonly string[]; mandate?: string };

export class PolicyVerifyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyVerifyInputError';
  }
}

const secretPathOf = (home: string, text: string): string => {
  if (text === '~' || text.startsWith('~/')) return path.join(home, text.slice(1));
  if (!path.isAbsolute(text)) throw new PolicyVerifyInputError(`--secret ${JSON.stringify(text)} must be an absolute path or start with ~/`);
  return text;
};

export const policyVerify = async (ports: CliPorts, paths: MomongaPaths, options: PolicyVerifyOptions): Promise<number> => {
  const secrets = options.secrets.map((text) => secretPathOf(ports.home, text));
  await ensureCurrentDaemon(ports, paths);
  const runtime = connectRuntime(ports, paths);
  try {
    const governance = await runtime.policyGovernance(ports.cwd);
    const verified = await runtime.policyVerify({
      project: ports.cwd,
      secrets,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.mandate === undefined ? {} : { mandate: options.mandate }),
    });
    const hasGovernance = governance.rules.length > 0 || governance.textOnly.length > 0;
    ports.stdout.write(
      options.json
        ? `${JSON.stringify(hasGovernance ? { ...verified.findings, governance } : verified.findings)}\n`
        : `${verified.text}\n${hasGovernance ? `${formatGovernanceVerification(governance, verified.exitCode === 0)}\n` : ''}`,
    );
    return verified.exitCode;
  } finally {
    await runtime.close();
  }
};
