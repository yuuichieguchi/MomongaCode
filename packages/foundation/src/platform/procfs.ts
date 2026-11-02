import fs from 'node:fs';

export type FileIdentity = { dev: bigint; ino: bigint };

export interface ProcFs {
  readText(file: string): Promise<string>;
  readBytes(file: string): Promise<Uint8Array>;
  list(directory: string): Promise<string[]>;
  identityOf(file: string): Promise<FileIdentity>;
  ownerOf(file: string): Promise<number>;
}

export const nodeProcFs: ProcFs = {
  readText: (file) => fs.promises.readFile(file, 'utf8'),
  readBytes: async (file) => new Uint8Array(await fs.promises.readFile(file)),
  list: (directory) => fs.promises.readdir(directory),
  identityOf: async (file) => {
    const stat = await fs.promises.stat(file, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  },
  ownerOf: async (file) => (await fs.promises.stat(file)).uid,
};
