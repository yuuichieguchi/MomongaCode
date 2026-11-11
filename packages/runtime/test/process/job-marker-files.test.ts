import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeJobMarkerFiles } from '@momonga/runtime';
import { createTempDir, removeTempDir } from '@momonga/testkit';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => removeTempDir(directory)));
});

const markerPath = (): string => {
  const directory = createTempDir();
  directories.push(directory);
  return path.join(directory, 'marker');
};

const isOpenOn = (descriptor: number, file: string): boolean => {
  try {
    return fs.fstatSync(descriptor).ino === fs.statSync(file).ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EBADF') return false;
    throw error;
  }
};

describe('the marker file of a background job', () => {
  it('keeps the marker descriptor open until an asynchronous spawn has settled, and closes it after', async () => {
    const marker = markerPath();
    const files = createNodeJobMarkerFiles();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let given = -1;
    const created = files.create(marker, async (markerFd) => {
      given = markerFd;
      await held;
      return isOpenOn(markerFd, marker);
    });
    await expect.poll(() => given).not.toBe(-1);
    expect(isOpenOn(given, marker)).toBe(true);
    release();
    await expect(created).resolves.toBe(true);
    expect(isOpenOn(given, marker)).toBe(false);
  });

  it('closes the marker descriptor when an asynchronous spawn rejects', async () => {
    const marker = markerPath();
    const files = createNodeJobMarkerFiles();
    let given = -1;
    await expect(
      files.create(marker, async (markerFd) => {
        given = markerFd;
        await Promise.resolve();
        if (!isOpenOn(markerFd, marker)) throw new Error('the marker descriptor was closed before the spawn settled');
        throw new Error('spawn failed');
      }),
    ).rejects.toThrow('spawn failed');
    expect(isOpenOn(given, marker)).toBe(false);
  });
});
