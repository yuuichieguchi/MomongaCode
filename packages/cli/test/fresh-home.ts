import { afterEach } from 'vitest';
import { createTempDir, removeTempDir } from '@momonga/testkit';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await removeTempDir(home);
});

export const freshHome = (): string => {
  const home = createTempDir({ asHome: true });
  homes.push(home);
  return home;
};
