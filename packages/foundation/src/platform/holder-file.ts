import fs from 'node:fs';
import { noFollowFlag } from './privacy.ts';

export const HOLDER_READ_MAX_BYTES = 64;

export const readHolderFile = async (lockPath: string): Promise<string | undefined> => {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(lockPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(HOLDER_READ_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HOLDER_READ_MAX_BYTES, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
};

export const readHolderFileSync = (lockPath: string): string | undefined => {
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(HOLDER_READ_MAX_BYTES);
    const bytesRead = fs.readSync(descriptor, buffer, 0, HOLDER_READ_MAX_BYTES, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
};

export const writeHolderFile = (holderFile: string, text: string): void => {
  const descriptor = fs.openSync(holderFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollowFlag(), 0o600);
  try {
    fs.writeSync(descriptor, text);
  } finally {
    fs.closeSync(descriptor);
  }
};

export const removeFilesThenRelease = (files: readonly string[], release: () => void): void => {
  try {
    for (const file of files) fs.rmSync(file, { force: true });
  } finally {
    release();
  }
};

export const readHolderFromDescriptor =(descriptor: number): string => {
  const buffer = Buffer.alloc(HOLDER_READ_MAX_BYTES);
  const bytesRead = fs.readSync(descriptor, buffer, 0, HOLDER_READ_MAX_BYTES, 0);
  return buffer.toString('utf8', 0, bytesRead);
};

export const rewriteHolderThroughDescriptor = (descriptor: number, text: string): void => {
  fs.ftruncateSync(descriptor, 0);
  fs.writeSync(descriptor, text, 0);
};
