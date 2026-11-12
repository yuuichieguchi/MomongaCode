import { nodeFileSystem } from '../node-file-system.ts';

export type FileIdentity = { dev: bigint; ino: bigint };

export interface ProcFs {
  readText(file: string): Promise<string>;
  readBytes(file: string): Promise<Uint8Array>;
  list(directory: string): Promise<string[]>;
  identityOf(file: string): Promise<FileIdentity>;
  birthMsOf(file: string): Promise<number>;
}

export const nodeProcFs: ProcFs = {
  readText: (file) => nodeFileSystem.readTextFile(file),
  readBytes: (file) => nodeFileSystem.readFile(file),
  list: (directory) => nodeFileSystem.readdir(directory),
  identityOf: (file) => nodeFileSystem.identity(file),
  birthMsOf: async (file) => (await nodeFileSystem.stat(file)).birthtimeMs,
};
