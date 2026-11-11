import { createPathResolver, isTransientErrno, nodeFileSystem, settledOrAborted } from '@momonga/foundation';
import type { FileSystem, PathResolver } from '@momonga/foundation';

export type Asker = { signal: AbortSignal; paths: PathResolver; files: FileSystem };

export const askerOf = (signal: AbortSignal, files: FileSystem = nodeFileSystem): Asker => ({ signal, paths: createPathResolver(files, signal), files });

export const asked = <Answer>({ signal }: Pick<Asker, 'signal'>, pending: Promise<Answer>): Promise<Answer> => settledOrAborted(pending, signal);

export const rethrowIfUnread = (error: unknown, signal: AbortSignal): void => {
  if (signal.aborted) throw signal.reason;
  if (isTransientErrno(error)) throw error;
};
