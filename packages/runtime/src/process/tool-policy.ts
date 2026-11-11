import path from 'node:path';
import { ConfigError } from '@momonga/config';
import { discoverGitConfigFiles, ensureSessionTmpDir as defaultEnsureSessionTmpDir, filterAsync, hostPaths, isTransientErrno, protectedSetFor, sessionRootsOf } from '@momonga/foundation';
import type { MomongaPaths, RuleEnforcement, SessionScratch, KernelLockMechanism } from '@momonga/foundation';
import { askedBy, computeFileRules } from '@momonga/policy';
import type { PolicyHostPorts } from '@momonga/policy';
import { buildSandboxPolicy } from '@momonga/tools';
import type { ToolRuntimePort } from '../ports.ts';
import type { SessionStates } from './session-states.ts';

export type RecoveryContextOptions = {
  paths: MomongaPaths;
  home: string;
  fs: PolicyHostPorts;
  sessionStates: Pick<SessionStates, 'get'>;
  lock: KernelLockMechanism;
  ensureSessionTmpDir?: (paths: MomongaPaths, sessionId: string) => Promise<SessionScratch>;
};

export type PolicyForOptions = RecoveryContextOptions & { ruleEnforcement: RuleEnforcement };

const wrapperFor =
  (sessionId: string) =>
  (cause: unknown): ConfigError =>
    cause instanceof ConfigError ? cause : new ConfigError(`the tool policy for session ${sessionId} could not be built: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });

const contextBuilder = ({ paths, home, sessionStates, lock, ensureSessionTmpDir = (layout, sessionId) => defaultEnsureSessionTmpDir(layout, sessionId, { lock }) }: RecoveryContextOptions) => {
  if (!path.isAbsolute(home)) throw new TypeError(`home must be an absolute path, got ${home}`);
  return async (session: Parameters<ToolRuntimePort['policyFor']>[0], signal: AbortSignal): Promise<{ roots: string[]; tmpDir: string; wrap: (cause: unknown) => ConfigError }> => {
    const resolver = hostPaths(signal);
    const wrap = wrapperFor(session.id);
    sessionStates.get(session);
    const resolved = await sessionRootsOf(session.cwd, session.additionalDirectories, resolver);
    if (!resolved.ok) throw wrap(new Error(`root ${resolved.root} ${resolved.reason}`));
    const { roots } = resolved;

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

  return async (session, { env, rules, readableDirectories, unixSocketAllow, signal, discoverGitConfig }) => {
    const { roots, tmpDir, wrap } = await contextFor(session, signal);
    try {
      const resolver = hostPaths(signal);
      const ports = askedBy(fs, signal);
      const fileRules = await computeFileRules(rules, roots, tmpDir, ruleEnforcement, ports);
      const gitConfigFiles = discoverGitConfig === true ? await discoverGitConfigFiles({ workingDirectory: session.cwd, env, signal }) : [];
      const protectedSet = await protectedSetFor(roots, ports, gitConfigFiles);
      const skillsRoot = await resolver.canonicalPath(paths.skills);
      const readAllowed = await filterAsync(readableDirectories ?? [], (directory) => resolver.comparableContains(skillsRoot, directory));
      const sandboxPolicy = await buildSandboxPolicy({ roots, home, layout: paths, tmpDir, sessionsTmpRoot: paths.tmp.sessions, fileRules, protectedSet, network: 'deny', readAllowed, ...(unixSocketAllow === undefined ? {} : { unixSocketAllow }) }, signal);
      return { roots, sandboxPolicy, tmpDir, env };
    } catch (error) {
      signal.throwIfAborted();
      if (isTransientErrno(error)) throw error;
      throw wrap(error);
    }
  };
};

export const createRecoveryContextFor = (options: RecoveryContextOptions): ToolRuntimePort['recoveryContextFor'] => {
  const contextFor = contextBuilder(options);
  return async (session, { env, signal }) => {
    const { roots, tmpDir } = await contextFor(session, signal);
    return { roots, tmpDir, env };
  };
};
