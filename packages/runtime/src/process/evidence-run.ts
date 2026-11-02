import { canonicalDirectory, protectedSetFor } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { computeFileRules } from '@momonga/policy';
import type { PolicyPorts } from '@momonga/policy';
import { SandboxPolicyError } from '@momonga/sandbox';
import type { Sandbox, SandboxedProcess } from '@momonga/sandbox';
import { buildSandboxPolicy, readOnlyEnvironment, readOnlySandboxPolicy } from '@momonga/tools';
import type { EvidenceRun } from '../memory/evidence.ts';

export type EvidenceRunnerOptions = {
  paths: MomongaPaths;
  home: string;
  fs: PolicyPorts;
  sandbox: Sandbox;
  env: Readonly<Record<string, string>>;
};

const textOf = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

export const createEvidenceRunner =
  ({ paths, home, fs, sandbox, env }: EvidenceRunnerOptions) =>
  (project: string): EvidenceRun =>
  async (command, signal) => {
    const root = canonicalDirectory(project);
    if (!root.ok) return { exitCode: null };
    const roots = [root.path];
    let child: SandboxedProcess;
    try {
      const policy = readOnlySandboxPolicy(
        buildSandboxPolicy({
          roots: [],
          home,
          sessionsTmpRoot: paths.tmp.sessions,
          fileRules: computeFileRules([], roots, null),
          protectedSet: protectedSetFor(roots, fs),
          network: command.network,
        }),
      );
      child = sandbox.spawn({ argv: command.argv, cwd: command.cwd, env: readOnlyEnvironment({ ...env, ...command.env }) }, policy, signal);
    } catch (error) {
      if (error instanceof SandboxPolicyError) return { exitCode: null };
      throw error;
    }
    const [stdout, , exit] = await Promise.all([textOf(child.stdout), textOf(child.stderr), child.exited]);
    return { exitCode: exit.code, stdout };
  };
