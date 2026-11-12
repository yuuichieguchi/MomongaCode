import type { ChildLaunch, LayoutEnvironment } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, DEFAULT_SANDBOX_EXEC_PATH, childProtectionFor, protectionCommandOf } from '@momonga/sandbox';

export type ManagedLaunchInput = {
  home: string;
  platform: NodeJS.Platform;
  env: LayoutEnvironment;
  isUsableBinary: (file: string) => Promise<boolean>;
};

export const managedLaunchOf = async ({ home, platform, env, isUsableBinary }: ManagedLaunchInput): Promise<ChildLaunch> => {
  const bubblewrap = platform === 'linux' && (await isUsableBinary(DEFAULT_BWRAP_PATH));
  const protection = childProtectionFor({ sandbox: 'none', home, platform, env, bubblewrap });
  return {
    protection,
    commandOf: (argv, scratch) => protectionCommandOf(protection, { platform, argv, scratch, sandboxExecPath: DEFAULT_SANDBOX_EXEC_PATH, bwrapPath: DEFAULT_BWRAP_PATH }),
  };
};
