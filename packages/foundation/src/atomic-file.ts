import fs from 'node:fs';
import path from 'node:path';

export const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const syncDirectorySync = (directory: string): void => {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

export type AtomicWriteOptions = { mode: number; randomHex(bytes: number): string };

const TEMPORARY_SUFFIX_BYTES = 6;

export const writeFileAtomically = async (file: string, content: string, options: AtomicWriteOptions): Promise<void> => {
  const temporary = `${file}.${process.pid}.${options.randomHex(TEMPORARY_SUFFIX_BYTES)}.tmp`;
  try {
    const handle = await fs.promises.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, options.mode);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporary, file);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
  await syncDirectory(path.dirname(file));
};
