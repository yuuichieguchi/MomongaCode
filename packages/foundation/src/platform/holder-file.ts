import { OPEN_FLAGS, nodeFileSystem, nodeFileSystemSync } from '../node-file-system.ts';

export const HOLDER_READ_MAX_BYTES = 64;

const textOf = (page: Uint8Array, length: number): string => Buffer.from(page.buffer, page.byteOffset, length).toString('utf8');

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export const readHolderFile = async (lockPath: string): Promise<string | undefined> => {
  let handle: Awaited<ReturnType<typeof nodeFileSystem.openRead>>;
  try {
    handle = await nodeFileSystem.openRead(lockPath, OPEN_FLAGS.readOnly | OPEN_FLAGS.noFollow);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  try {
    const page = new Uint8Array(HOLDER_READ_MAX_BYTES);
    return textOf(page, await handle.readAt(page, 0));
  } finally {
    await handle.close();
  }
};

export const readHolderFileSync = (lockPath: string): string | undefined => {
  let descriptor: number;
  try {
    descriptor = nodeFileSystemSync.openReadNoFollowSync(lockPath);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  try {
    return readHolderFromDescriptor(descriptor);
  } finally {
    nodeFileSystemSync.closeSync(descriptor);
  }
};

export const writeHolderFile = (holderFile: string, text: string): void => {
  const descriptor = nodeFileSystemSync.openDescriptorSync(holderFile, OPEN_FLAGS.writeOnly | OPEN_FLAGS.create | OPEN_FLAGS.truncate | OPEN_FLAGS.noFollow, 0o600);
  try {
    nodeFileSystemSync.writeTextSync(descriptor, text);
  } finally {
    nodeFileSystemSync.closeSync(descriptor);
  }
};

export const removeFilesThenRelease = (files: readonly string[], release: () => void): void => {
  try {
    for (const file of files) nodeFileSystemSync.rmSync(file);
  } finally {
    release();
  }
};

export const readHolderFromDescriptor = (descriptor: number): string => {
  const page = new Uint8Array(HOLDER_READ_MAX_BYTES);
  return textOf(page, nodeFileSystemSync.readAtSync(descriptor, page, 0));
};

export const rewriteHolderThroughDescriptor = (descriptor: number, text: string): void => {
  nodeFileSystemSync.truncateSync(descriptor, 0);
  nodeFileSystemSync.writeTextAtSync(descriptor, text, 0);
};
