import { canonicalHomeOf, createPathResolver } from '@momonga/foundation';
import type { FileSystem, LayoutEnvironment, PathFileSystem } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, DEFAULT_SANDBOX_EXEC_PATH, bubblewrapPresent, childProtectionFor, protectionCommandOf } from '@momonga/sandbox';
import type { ChildLaunch } from './ports.ts';

export type HomeProtectedLaunchInput = {
  home: string;
  platform: NodeJS.Platform;
  env: LayoutEnvironment;
  files: PathFileSystem & Pick<FileSystem, 'access'>;
};

export const homeProtectedLaunch = async (input: HomeProtectedLaunchInput, signal: AbortSignal): Promise<ChildLaunch> => {
  const { platform } = input;
  const home = await canonicalHomeOf(input.home, createPathResolver(input.files, signal));
  const bubblewrap = platform === 'linux' && (await bubblewrapPresent(DEFAULT_BWRAP_PATH, (file) => input.files.access(file, 'execute')));
  const protection = childProtectionFor({ sandbox: 'none', home, platform, env: input.env, bubblewrap });
  return {
    protection,
    commandOf: (argv, scratch) => protectionCommandOf(protection, { platform, argv, scratch, sandboxExecPath: DEFAULT_SANDBOX_EXEC_PATH, bwrapPath: DEFAULT_BWRAP_PATH }),
  };
};
