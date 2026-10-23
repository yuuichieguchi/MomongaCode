import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import { INSTRUCTION_FILE_LIMIT_BYTES } from './instructions.ts';
import type { InstructionReader } from './types.ts';

const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ENXIO', 'ENODEV', 'EOPNOTSUPP']);
const UTF8_MAX_CHAR_BYTES = 4;

const ABSENT_ERRNOS = new Set(
  [...ABSENT_CODES].flatMap((code) => {
    const errno: unknown = Object.entries(os.constants.errno).find(([name]) => name === code)?.[1];
    return typeof errno === 'number' ? [-errno] : [];
  }),
);

const isAbsent = (error: unknown): boolean =>
  error instanceof Error &&
  (('code' in error && typeof error.code === 'string' && ABSENT_CODES.has(error.code)) ||
    ('errno' in error && typeof error.errno === 'number' && ABSENT_ERRNOS.has(error.errno)));

const withRegularFile = async <T>(
  filePath: string,
  use: (realPath: string, handle: fs.FileHandle) => Promise<T>,
): Promise<T | undefined> => {
  try {
    const realPath = await fs.realpath(filePath);
    const handle = await fs.open(realPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      return await use(realPath, handle);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
};

export const createFsInstructionReader = (): InstructionReader => ({
  read: (filePath) =>
    withRegularFile(filePath, async (realPath, handle) => {
      const buffer = new Uint8Array(INSTRUCTION_FILE_LIMIT_BYTES + UTF8_MAX_CHAR_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { realPath, text: new TextDecoder().decode(buffer.subarray(0, bytesRead)) };
    }),
  exists: async (filePath) => (await withRegularFile(filePath, async () => true)) === true,
  realpath: async (filePath) => {
    try {
      return await fs.realpath(filePath);
    } catch (error) {
      if (isAbsent(error)) return undefined;
      throw error;
    }
  },
});
