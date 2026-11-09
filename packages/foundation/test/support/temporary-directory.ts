import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { shortTempBase } from '@momonga/foundation';

const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const makeUnder = (base: string): string => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(base, 'mm-foundation-')));
  created.push(directory);
  return directory;
};

export const makeTemporaryDirectory = (): string => makeUnder(os.tmpdir());

export const makeShortHomeDirectory = (): string => makeUnder(shortTempBase(process.platform));
