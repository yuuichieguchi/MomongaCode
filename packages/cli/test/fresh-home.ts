import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

export const freshHome = (): string => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-home-')));
  homes.push(home);
  return home;
};
