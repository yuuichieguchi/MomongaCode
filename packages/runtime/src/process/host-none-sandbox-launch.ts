import { canonicalHomeOf, createPathResolver, nodeFileSystem } from '@momonga/foundation';
import type { ChildLaunch, LayoutEnvironment } from '@momonga/foundation';
import { bubblewrapPresent, noneSandboxLaunchOf } from '@momonga/sandbox';

export const hostNoneSandboxLaunch = async (input: { home: string; platform: NodeJS.Platform; env: LayoutEnvironment }, signal: AbortSignal): Promise<ChildLaunch> =>
  noneSandboxLaunchOf({
    home: await canonicalHomeOf(input.home, createPathResolver(nodeFileSystem, signal)),
    platform: input.platform,
    env: input.env,
    isUsableBinary: (file) => bubblewrapPresent(file, (candidate) => nodeFileSystem.access(candidate, 'execute')),
  });
