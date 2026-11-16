import { canonicalHomeOf } from '@momonga/foundation';
import type { ChildLaunch, LayoutEnvironment, PathResolver } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH } from './bubblewrap.ts';
import { childProtectionFor, protectionCommandOf } from './protection.ts';
import { DEFAULT_SANDBOX_EXEC_PATH } from './seatbelt.ts';

export type NoneSandboxLaunchInput = {
  home: string;
  platform: NodeJS.Platform;
  env: LayoutEnvironment;
  paths: PathResolver;
  isUsableBinary: (file: string) => Promise<boolean>;
};

export const noneSandboxLaunchOf = async ({ home: given, platform, env, paths, isUsableBinary }: NoneSandboxLaunchInput): Promise<ChildLaunch> => {
  const home = await canonicalHomeOf(given, paths);
  const bubblewrap = platform === 'linux' && (await isUsableBinary(DEFAULT_BWRAP_PATH));
  const protection = childProtectionFor({ sandbox: 'none', home, platform, env, bubblewrap });
  return {
    protection,
    commandOf: (argv, scratch) => protectionCommandOf(protection, { platform, argv, scratch, sandboxExecPath: DEFAULT_SANDBOX_EXEC_PATH, bwrapPath: DEFAULT_BWRAP_PATH }),
  };
};
