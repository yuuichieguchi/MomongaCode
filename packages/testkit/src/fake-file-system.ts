import path from 'node:path';
import type { AtomicWriteFileSystemSync, FileContent, FileSystem } from '@momonga/foundation';

export type FakeFileSystem = FileSystem &
  AtomicWriteFileSystemSync & {
    readonly files: Map<string, Uint8Array>;
    readonly directories: Set<string>;
  };

const errnoError = (code: string, file: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: ${file}`), { code });

const bytesOf = (content: FileContent): Uint8Array => (typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content));

export const createFakeFileSystem = (directories: readonly string[]): FakeFileSystem => {
  const files = new Map<string, Uint8Array>();
  const known = new Set(directories);
  const openSync = (file: string, flags: string): string => {
    if (known.has(file)) return file;
    if (!known.has(path.dirname(file))) throw errnoError('ENOENT', file);
    if (flags.includes('x') && files.has(file)) throw errnoError('EEXIST', file);
    if (flags.includes('w')) files.set(file, new Uint8Array());
    else if (!files.has(file)) throw errnoError('ENOENT', file);
    return file;
  };
  const writeFileSync = (handle: string, content: FileContent): void => {
    files.set(handle, bytesOf(content));
  };
  const renameSync = (from: string, to: string): void => {
    const content = files.get(from);
    if (content === undefined) throw errnoError('ENOENT', from);
    files.set(to, content);
    files.delete(from);
  };
  const linkSync = (from: string, to: string): void => {
    if (files.has(to)) throw errnoError('EEXIST', to);
    const content = files.get(from);
    if (content === undefined) throw errnoError('ENOENT', from);
    files.set(to, content);
  };
  const rmSync = (file: string): void => {
    files.delete(file);
  };
  const noop = (): void => undefined;
  const contentOf = (file: string): Uint8Array => {
    const content = files.get(file);
    if (content === undefined) throw errnoError('ENOENT', file);
    return content;
  };
  return {
    files,
    directories: known,
    open: async (file, flags) => {
      const handle = openSync(file, flags);
      return {
        writeFile: async (content) => writeFileSync(handle, content),
        sync: async () => undefined,
        close: async () => undefined,
      };
    },
    rename: async (from, to) => renameSync(from, to),
    link: async (from, to) => linkSync(from, to),
    rm: async (file) => rmSync(file),
    readText: async (file) => new TextDecoder().decode(contentOf(file)),
    readdir: async (directory) => {
      if (!known.has(directory)) throw errnoError('ENOENT', directory);
      return [...files.keys(), ...known].filter((entry) => path.dirname(entry) === directory && entry !== directory).map((entry) => path.basename(entry));
    },
    openThenClose: async (file) => {
      contentOf(file);
    },
    writeByteAt: async (file, position, byte) => {
      const content = new Uint8Array(contentOf(file));
      content.set(new TextEncoder().encode(byte), position);
      files.set(file, content);
    },
    openSync,
    writeFileSync,
    fsyncSync: noop,
    closeSync: noop,
    renameSync,
    linkSync,
    rmSync,
  };
};
