import { nodeFileSystem } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';

export type RuntimeFiles = Pick<FileSystem, 'readdir' | 'rm'>;

export const nodeRuntimeFiles: RuntimeFiles = {
  readdir: nodeFileSystem.readdir,
  rm: nodeFileSystem.rm,
};
