import path from 'node:path';
import { OPEN_FLAGS } from '@momonga/foundation';
import type { FileContent, FileSystem } from '@momonga/foundation';

export type FileSystemFault = { readonly code: string; readonly under: string; readonly holds: () => boolean; readonly refused: (file: string) => void };

const WRITING_OPEN_FLAGS = OPEN_FLAGS.writeOnly | OPEN_FLAGS.readWrite | OPEN_FLAGS.create | OPEN_FLAGS.truncate;

const isWritingOpen = (flags: string | number): boolean => (typeof flags === 'number' ? (flags & WRITING_OPEN_FLAGS) !== 0 : /[wa+]/.test(flags));

export const fileSystemWithFault = (base: FileSystem, fault: FileSystemFault): FileSystem => {
  const prefix = fault.under.endsWith(path.sep) ? fault.under : `${fault.under}${path.sep}`;
  const refuse = (file: string, syscall: string): void => {
    if (!fault.holds() || (file !== fault.under && !file.startsWith(prefix))) return;
    fault.refused(file);
    throw Object.assign(new Error(`${fault.code}: injected fault of the file-system port, ${syscall} '${file}'`), { code: fault.code, syscall, path: file });
  };
  const guarded =
    <Args extends unknown[], Result>(syscall: string, target: (...args: Args) => string, operation: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      refuse(target(...args), syscall);
      return operation(...args);
    };
  return {
    ...base,
    open: async (file, flags, mode) => {
      if (isWritingOpen(flags)) refuse(file, 'open');
      return base.open(file, flags, mode);
    },
    openThenClose: async (file, flags) => {
      if (isWritingOpen(flags)) refuse(file, 'open');
      return base.openThenClose(file, flags);
    },
    rename: async (from, to) => {
      refuse(from, 'rename');
      refuse(to, 'rename');
      return base.rename(from, to);
    },
    link: guarded('link', (_from: string, to: string) => to, base.link),
    writeFile: guarded('write', (file: string, _content: FileContent) => file, base.writeFile),
    mkdir: guarded('mkdir', (directory: string) => directory, base.mkdir),
    mkdirPrivate: guarded('mkdir', (directory: string) => directory, base.mkdirPrivate),
    makeDirectory: guarded('mkdir', (directory: string) => directory, base.makeDirectory),
    cp: guarded('copyfile', (_from: string, to: string) => to, base.cp),
    mkdtemp: guarded('mkdtemp', (prefixOfTemp: string) => prefixOfTemp, base.mkdtemp),
    writeByteAt: guarded('write', (file: string, _position: number, _byte: string) => file, base.writeByteAt),
  };
};
