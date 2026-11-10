import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINIMAL_CHILD_PATH, SECRET_STORE_SEARCHED_PROGRAMS } from '@momonga/foundation';

import { fakeSecretProgramsBin } from './secret-store-env-check.ts';

export { TEST_SECRET_PROGRAMS_ENV, fakeSecretProgramsBin } from './secret-store-env-check.ts';

const FAKE_PROGRAM_MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-secret-program-main.ts');

export const shellQuoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

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
const MARKER_FILE = '.momonga-fake-secret-programs';
const ROOT_ENTRIES = [MARKER_FILE, 'bin', 'items'].sort();

export type FakeSecretPrograms = { root: string; bin: string };

type Marker = { token: string; root: string };

export const createFakeSecretPrograms = (): FakeSecretPrograms => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), ROOT_PREFIX)));
  fs.chmodSync(root, 0o700);
  const bin = installFakeSecretPrograms(root);
  const marker: Marker = { token: randomBytes(32).toString('hex'), root };
  fs.writeFileSync(path.join(root, MARKER_FILE), JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
  return { root, bin };
};

const isCreatedHere = (root: string): boolean => {
  let real: string;
  try {
    real = fs.realpathSync(root);
  } catch {
    return false;
  }
  if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith(ROOT_PREFIX)) return false;
  if (JSON.stringify(fs.readdirSync(real).sort()) !== JSON.stringify(ROOT_ENTRIES)) return false;
  const marker = JSON.parse(fs.readFileSync(path.join(real, MARKER_FILE), 'utf8')) as Partial<Marker>;
  return marker.root === real && typeof marker.token === 'string' && /^[0-9a-f]{64}$/.test(marker.token);
};

export const removeFakeSecretPrograms = (root: string): void => {
  if (!isCreatedHere(root)) throw new Error(`${root} is not a fake secret programs directory`);
  fs.rmSync(fs.realpathSync(root), { recursive: true, force: true });
};

export const posixPathLine = (bin: string): string => `PATH=${shellQuoted(bin)}:"$PATH"`;

export const testHostPath = (base: string = MINIMAL_CHILD_PATH): string => `${fakeSecretProgramsBin()}${path.delimiter}${base}`;
