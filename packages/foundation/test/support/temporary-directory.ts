import { afterEach } from 'vitest';
import { createTempDir, removeTempDir } from '@momonga/testkit';
import type { TempDirOptions } from '@momonga/testkit';

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) await removeTempDir(directory);
});

const make = (options: TempDirOptions): string => {
  const directory = createTempDir(options);
  created.push(directory);
  return directory;
};

export const makeTemporaryDirectory = (): string => make({});

export const makeShortHomeDirectory = (): string => make({ asHome: true });
