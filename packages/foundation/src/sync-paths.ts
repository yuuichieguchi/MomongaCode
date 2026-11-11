import path from 'node:path';
import { nodeFileSystemSync } from './node-file-system.ts';
import { createSyncPathResolver } from './path-compare.ts';
import type { SyncPathResolver } from './path-compare.ts';
import { canonicalOrWritten, displayAmong, parentFormOf } from './tool-path.ts';

export const syncPaths: SyncPathResolver = createSyncPathResolver({
  stat: (target) => nodeFileSystemSync.statSync(target),
  lstat: (target) => nodeFileSystemSync.lstatSync(target),
  readlink: (target) => nodeFileSystemSync.readlinkSync(target),
  realpath: (target) => nodeFileSystemSync.realpathSync(target),
  list: (target) => nodeFileSystemSync.accessSync(target, 'list'),
  names: (directory) => nodeFileSystemSync.readdirSync(directory),
});

export const displayToolPathSync = (workingDirectory: string, absolute: string): string => {
  const bases = [workingDirectory, canonicalOrWritten(workingDirectory, syncPaths.resolveCanonicalPath(workingDirectory))];
  return displayAmong(bases, [absolute, parentFormOf(absolute, syncPaths.resolveCanonicalPath(path.dirname(absolute)))], absolute);
};
