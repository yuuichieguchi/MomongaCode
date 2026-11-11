import { hostPaths, isTransientErrno } from '@momonga/foundation';
import type { PathResolver } from '@momonga/foundation';

export type Asker = { signal: AbortSignal; paths: PathResolver };

export const askerOf = (signal: AbortSignal): Asker => ({ signal, paths: hostPaths(signal) });

export const rethrowIfUnread = (error: unknown, signal: AbortSignal): void => {
  if (signal.aborted) throw signal.reason;
  if (isTransientErrno(error)) throw error;
};
