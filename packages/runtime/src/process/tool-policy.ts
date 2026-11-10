import path from 'node:path';
import { ConfigError } from '@momonga/config';
import { canonicalDirectory, canonicalPath, comparableContains, ensureSessionTmpDir as defaultEnsureSessionTmpDir, isTransientErrno, protectedSetFor } from '@momonga/foundation';
import type { MomongaPaths, RuleEnforcement, SessionScratch } from '@momonga/foundation';
import { computeFileRules } from '@momonga/policy';
import type { PolicyPorts } from '@momonga/policy';
import { buildSandboxPolicy } from '@momonga/tools';
import type { ToolRuntimePort } from '../ports.ts';
import type { SessionStates } from './session-states.ts';

export type RecoveryContextOptions = {
  paths: MomongaPaths;
  home: string;
  fs: PolicyPorts;
  sessionStates: Pick<SessionStates, 'get'>;
  ensureSessionTmpDir?: (paths: MomongaPaths, sessionId: string) => Promise<SessionScratch>;
};

export type PolicyForOptions = RecoveryContextOptions & { ruleEnforcement: RuleEnforcement };

const wrapperFor =
  (sessionId: string) =>
  (cause: unknown): ConfigError =>
    cause instanceof ConfigError ? cause : new ConfigError(`the tool policy for session ${sessionId} could not be built: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });

const contextBuilder = ({ paths, home, sessionStates, ensureSessionTmpDir = defaultEnsureSessionTmpDir }: RecoveryContextOptions) => {
  if (!path.isAbsolute(home)) throw new TypeError(`home must be an absolute path, got ${home}`);
  return async (session: Parameters<ToolRuntimePort['policyFor']>[0]): Promise<{ roots: string[]; tmpDir: string; wrap: (cause: unknown) => ConfigError }> => {
    const wrap = wrapperFor(session.id);
    sessionStates.get(session);
    const roots: string[] = [];
    for (const root of [session.cwd, ...session.additionalDirectories]) {
      const result = canonicalDirectory(root);
      if (!result.ok) throw wrap(new Error(`root ${root} ${result.reason}`));
      roots.push(result.path);
    }

    let tmpDir: string;
    try {
      tmpDir = (await ensureSessionTmpDir(paths, session.id)).dir;
    } catch (error) {
      if (isTransientErrno(error)) throw error;
      throw wrap(error);
    }
    return { roots, tmpDir, wrap };
  };
};

export type EnforcedPolicyFor = (session: Parameters<ToolRuntimePort['policyFor']>[0], options: Omit<Parameters<ToolRuntimePort['policyFor']>[1], 'ruleEnforcement'> & { unixSocketAllow?: readonly string[] }) => ReturnType<ToolRuntimePort['policyFor']>;

export const createPolicyFor = (options: PolicyForOptions): EnforcedPolicyFor => {
  const { paths, home, fs, ruleEnforcement } = options;
  const contextFor = contextBuilder(options);

  return async (session, { env, rules, readableDirectories, unixSocketAllow }) => {
    const { roots, tmpDir, wrap } = await contextFor(session);
    try {
      const fileRules = computeFileRules(rules, roots, tmpDir, ruleEnforcement);
      const protectedSet = protectedSetFor(roots, fs);
      const skillsRoot = canonicalPath(paths.skills);
      const readAllowed = (readableDirectories ?? []).filter((directory) => comparableContains(skillsRoot, directory));
      const sandboxPolicy = buildSandboxPolicy({ roots, home, tmpDir, sessionsTmpRoot: paths.tmp.sessions, fileRules, protectedSet, network: 'deny', readAllowed, ...(unixSocketAllow === undefined ? {} : { unixSocketAllow }) });
      return { roots, sandboxPolicy, tmpDir, env };
    } catch (error) {
      if (isTransientErrno(error)) throw error;
      throw wrap(error);
    }
  };
};

export const createRecoveryContextFor = (options: RecoveryContextOptions): ToolRuntimePort['recoveryContextFor'] => {
  const contextFor = contextBuilder(options);
  return async (session, { env }) => {
    const { roots, tmpDir } = await contextFor(session);
    return { roots, tmpDir, env };
  };
};
