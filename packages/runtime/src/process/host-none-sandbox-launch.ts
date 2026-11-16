import { createPathResolver, nodeFileSystem } from '@momonga/foundation';
import type { ChildLaunch, LayoutEnvironment } from '@momonga/foundation';
import { bubblewrapPresent, noneSandboxLaunchOf } from '@momonga/sandbox';

export const hostNoneSandboxLaunch = (input: { home: string; platform: NodeJS.Platform; env: LayoutEnvironment }, signal: AbortSignal): Promise<ChildLaunch> =>
  noneSandboxLaunchOf({
    ...input,
    paths: createPathResolver(nodeFileSystem, signal),
    isUsableBinary: (file) => bubblewrapPresent(file, (candidate) => nodeFileSystem.access(candidate, 'execute')),
  });
