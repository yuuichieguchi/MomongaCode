import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINIMAL_CHILD_PATH, SECRET_STORE_SEARCHED_PROGRAMS } from '@momonga/foundation';

import { fakeSecretProgramsBin } from './secret-store-env-check.ts';

export { TEST_SECRET_PROGRAMS_ENV, fakeSecretProgramsBin } from './secret-store-env-check.ts';

const FAKE_PROGRAM_MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-secret-program-main.ts');

const shellQuoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

const launcherOf = (platform: NodeJS.Platform, items: string, program: string): { name: string; text: string } =>
  platform === 'win32'
    ? { name: `${program}.cmd`, text: `@"${process.execPath}" "${FAKE_PROGRAM_MAIN}" "${items}" ${program} %*\r\n` }
    : { name: program, text: `#!/bin/sh\nexec ${shellQuoted(process.execPath)} ${shellQuoted(FAKE_PROGRAM_MAIN)} ${shellQuoted(items)} ${program} "$@"\n` };

export const installFakeSecretPrograms = (root: string, platform: NodeJS.Platform = process.platform): string => {
  const bin = path.join(root, 'bin');
  const items = path.join(root, 'items');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.mkdirSync(items, { recursive: true, mode: 0o700 });
  for (const program of SECRET_STORE_SEARCHED_PROGRAMS) {
    const launcher = launcherOf(platform, items, program);
    fs.writeFileSync(path.join(bin, launcher.name), launcher.text, { mode: 0o755 });
  }
  return bin;
};

const ROOT_PREFIX = 'momonga-secret-programs-';

export type FakeSecretPrograms = { root: string; bin: string };

export const createFakeSecretPrograms = (): FakeSecretPrograms => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), ROOT_PREFIX));
  fs.chmodSync(root, 0o700);
  return { root, bin: installFakeSecretPrograms(root) };
};

export const removeFakeSecretPrograms = (root: string): void => {
  const isFake = path.basename(root).startsWith(ROOT_PREFIX) && fs.existsSync(path.join(root, 'bin')) && fs.existsSync(path.join(root, 'items'));
  if (!isFake) throw new Error(`${root} is not a fake secret programs directory`);
  fs.rmSync(root, { recursive: true, force: true });
};


export const testHostPath = (base: string = MINIMAL_CHILD_PATH): string => `${fakeSecretProgramsBin()}${path.delimiter}${base}`;
