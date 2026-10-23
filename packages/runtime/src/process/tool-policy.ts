import path from 'node:path';
import { ConfigError } from '@momonga/config';
import { canonicalDirectory, ensureSessionTmpDir as defaultEnsureSessionTmpDir, isTransientErrno } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { buildSandboxPolicy, protectedPathsFor } from '@momonga/tools';
import type { ToolRuntimePort } from '../ports.ts';
import type { SessionStates } from './session-states.ts';

export type PolicyForOptions = {
  paths: MomongaPaths;
  home: string;
  sessionStates: Pick<SessionStates, 'get'>;
  ensureSessionTmpDir?: (paths: MomongaPaths, sessionId: string) => Promise<string>;
};

export const createPolicyFor = ({ paths, home, sessionStates, ensureSessionTmpDir = defaultEnsureSessionTmpDir }: PolicyForOptions): ToolRuntimePort['policyFor'] => {
  if (!path.isAbsolute(home)) throw new TypeError(`home must be an absolute path, got ${home}`);

  return async (session, { env }) => {
    const wrap = (cause: unknown): ConfigError =>
      cause instanceof ConfigError ? cause : new ConfigError(`the tool policy for session ${session.id} could not be built: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });

    sessionStates.get(session);
    const roots = [session.cwd, ...session.additionalDirectories];
    for (const root of roots) {
      const result = canonicalDirectory(root);
      if (!result.ok) throw wrap(new Error(`root ${root} ${result.reason}`));
    }

    let tmpDir: string;
    try {
      tmpDir = await ensureSessionTmpDir(paths, session.id);
    } catch (error) {
      if (isTransientErrno(error)) throw error;
      throw wrap(error);
    }

    try {
      const sandboxPolicy = buildSandboxPolicy({ roots, home, tmpDir, sessionsTmpRoot: paths.tmp.sessions, network: 'deny' });
      const protectedPaths = protectedPathsFor(roots);
      return { roots, sandboxPolicy, tmpDir, protectedPaths, env };
    } catch (error) {
      if (isTransientErrno(error)) throw error;
      throw wrap(error);
    }
  };
};
