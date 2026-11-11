import { canonicalHomeOf, hostPaths, nodeFileSystem } from '@momonga/foundation';
import type { ChildProtection, LayoutEnvironment } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, DEFAULT_SANDBOX_EXEC_PATH, bubblewrapPresent, childProtectionFor, protectionCommandOf } from '@momonga/sandbox';
import { executableCheckOn, resolveBashPath } from '@momonga/tools';

export type WorkspaceCommandSandboxInput = { home: string; platform: NodeJS.Platform; env: LayoutEnvironment; signal: AbortSignal };

export type WorkspaceCommand = { file: string; args: readonly string[]; protection: ChildProtection };

export type WorkspaceCommandSandbox = { commandOf(command: string, workspace: string): Promise<WorkspaceCommand> };

export const workspaceCommandSandbox = async (input: WorkspaceCommandSandboxInput): Promise<WorkspaceCommandSandbox> => {
  const home = await canonicalHomeOf(input.home, hostPaths(input.signal));
  const bubblewrap = input.platform === 'linux' && (await bubblewrapPresent(DEFAULT_BWRAP_PATH, (file) => nodeFileSystem.access(file, 'execute')));
  const protection = childProtectionFor({ sandbox: 'none', home, platform: input.platform, env: input.env, bubblewrap });
  const shell = await resolveBashPath(input.platform, { isExecutable: executableCheckOn(nodeFileSystem), env: input.env });
  return {
    commandOf: async (command) => ({
      ...protectionCommandOf(protection, { platform: input.platform, argv: [shell, '-c', command], scratch: [], sandboxExecPath: DEFAULT_SANDBOX_EXEC_PATH, bwrapPath: DEFAULT_BWRAP_PATH }),
      protection,
    }),
  };
};
