import { canonicalDirectory, ensureSessionTmpDir,protectedSetFor } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { computeFileRules } from '@momonga/policy';
import type { PolicyPorts } from '@momonga/policy';
import type { Sandbox } from '@momonga/sandbox';
import { buildSandboxPolicy } from '@momonga/tools';
import type { EvidenceRun } from '../memory/evidence.ts';

export const EVIDENCE_TMP_ID = 'evidence';

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
  async (command) => {
    const root = canonicalDirectory(project);
    if (!root.ok) throw new Error(`the evidence project ${project} ${root.reason}`);
    const roots = [root.path];
    const tmpDir = await ensureSessionTmpDir(paths, EVIDENCE_TMP_ID);
    const policy = buildSandboxPolicy({
      roots,
      home,
      tmpDir,
      sessionsTmpRoot: paths.tmp.sessions,
      fileRules: computeFileRules([], roots, tmpDir),
      protectedSet: protectedSetFor(roots, fs),
      network: command.network,
    });
    const child = sandbox.spawn({ argv: command.argv, cwd: command.cwd, env: { ...env, ...command.env }, tmpDir }, policy, new AbortController().signal);
    const [stdout, , exit] = await Promise.all([textOf(child.stdout), textOf(child.stderr), child.exited]);
    return { exitCode: exit.code, stdout };
  };
