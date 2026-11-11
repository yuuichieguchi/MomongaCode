import { canonicalHomeOf, hostPaths, momongaPaths, nodeFileSystem, resolveLayoutLocks, ruleEnforcementOf } from '@momonga/foundation';
import type { LayoutEnvironment, SandboxNetworkSetting } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, bubblewrapPresent, childProtectionFor } from '@momonga/sandbox';
import type { SandboxSetting } from '@momonga/sandbox';
import { createPolicyFilesystem, nodeShellHost, resolveBashPath } from '@momonga/tools';
import { createSandboxOf, placeholderJournalDirectoryOf } from './sandbox-of.ts';
import { toolSandboxPolicyOf } from './tool-policy.ts';

export type WorkspaceCommandSandboxInput = {
  home: string;
  platform: NodeJS.Platform;
  env: LayoutEnvironment;
  signal: AbortSignal;
  sandbox: SandboxSetting;
  network: SandboxNetworkSetting;
  warn(text: string): void;
};

export type WorkspaceCommandRun = { pgid: number; exited: Promise<{ code: number | null }> };

export type WorkspaceCommandSandbox = { start(command: string, workspace: string, env: Readonly<Record<string, string>>, signal: AbortSignal): Promise<WorkspaceCommandRun> };

const drained = async (stream: AsyncIterable<Uint8Array>): Promise<void> => {
  for await (const _chunk of stream);
};

export const workspaceCommandSandbox = async (input: WorkspaceCommandSandboxInput): Promise<WorkspaceCommandSandbox> => {
  const resolver = hostPaths(input.signal);
  const home = await canonicalHomeOf(input.home, resolver);
  const paths = momongaPaths(home, input.platform, input.env);
  const shellHost = nodeShellHost();
  const bubblewrap = input.platform === 'linux' && (await bubblewrapPresent(DEFAULT_BWRAP_PATH, (file) => nodeFileSystem.access(file, 'execute')));
  const sandbox = await createSandboxOf({
    platform: input.platform,
    paths,
    env: input.env,
    shellHost,
    kernelLock: resolveLayoutLocks(paths).mechanism,
    journalDirectory: placeholderJournalDirectoryOf(paths),
    noneProtection: childProtectionFor({ sandbox: 'none', home, platform: input.platform, env: input.env, bubblewrap }),
    warn: input.warn,
  })(input.sandbox, input.signal);
  const ruleEnforcement = ruleEnforcementOf(sandbox.kind);
  const shell = await resolveBashPath(input.platform, { isExecutable: shellHost.isExecutable, env: input.env });
  const network = input.network === 'allow' ? 'allow' : 'deny';
  return {
    start: async (command, workspace, env, signal) => {
      const root = await resolver.canonicalPath(workspace);
      const policy = await toolSandboxPolicyOf({ paths, home, fs: createPolicyFilesystem(), ruleEnforcement }, { roots: [root], tmpDir: undefined, rules: [], gitConfigFiles: [], readableDirectories: [] }, signal);
      const child = await sandbox.spawn({ argv: [shell, '-c', command], cwd: root, env }, { ...policy, network }, signal);
      const output = Promise.all([drained(child.stdout), drained(child.stderr)]);
      return { pgid: child.pgid, exited: Promise.all([child.exited, output]).then(([exit]) => ({ code: exit.code })) };
    },
  };
};
