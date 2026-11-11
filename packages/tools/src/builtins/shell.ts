import type { FileSystem, FileSystemSync } from '@momonga/foundation';
import type { ExecutableCheck, ShellPortsNow } from '@momonga/policy';
import type { ChildPorts } from '../ports.ts';

export { ShellNotFoundError, resolveBashPath, resolveBashPathNow } from '@momonga/policy';
export type { ExecutableCheck, ShellPorts, ShellPortsNow } from '@momonga/policy';

export type ShellHost = { platform: NodeJS.Platform; isExecutable: ExecutableCheck; child: ChildPorts };

const absentOrThrown = (error: unknown): false => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
  throw error;
};

export const executableCheckOn =
  (files: Pick<FileSystem, 'access' | 'stat'>): ExecutableCheck =>
  async (file) => {
    try {
      await files.access(file, 'execute');
      return (await files.stat(file)).isFile();
    } catch (error) {
      return absentOrThrown(error);
    }
  };

export const executableCheckNowOn =
  (files: Pick<FileSystemSync, 'accessSync' | 'statSync'>): ShellPortsNow['isExecutable'] =>
  (file) => {
    try {
      files.accessSync(file, 'execute');
      return files.statSync(file).isFile();
    } catch (error) {
      return absentOrThrown(error);
    }
  };
