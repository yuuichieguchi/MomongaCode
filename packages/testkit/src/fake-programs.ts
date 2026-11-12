import fs from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINIMAL_CHILD_PATH, SECRET_STORE_SEARCHED_PROGRAMS, URL_OPENER_PROGRAMS } from '@momonga/foundation';

import { FAKE_CALL_MODES, FAKE_READINESS_VALUES, READY_CONTROL } from './fake-secrets.ts';
import type { FakeControl } from './fake-secrets.ts';
import { openerRecordIn } from './opener-record.ts';
import { fakeSecretProgramsBin } from './secret-store-env-check.ts';

export { TEST_OPENER_RECORD_ENV, readOpenerRecord } from './opener-record.ts';
export type { OpenerCall } from './opener-record.ts';
export { TEST_SECRET_PROGRAMS_ENV, fakeSecretProgramsBin } from './secret-store-env-check.ts';

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SECRET_PROGRAM_MAIN = path.join(SOURCE_DIRECTORY, 'fake-secret-program-main.ts');
const FAKE_OPENER_MAIN = path.join(SOURCE_DIRECTORY, 'fake-opener-main.ts');
const BROWSER_STAND_IN = 'browser';

const STAND_INS: ReadonlyArray<{ program: string; main: string }> = [
  ...SECRET_STORE_SEARCHED_PROGRAMS.map((program) => ({ program, main: FAKE_SECRET_PROGRAM_MAIN })),
  ...[...URL_OPENER_PROGRAMS, BROWSER_STAND_IN].map((program) => ({ program, main: FAKE_OPENER_MAIN })),
];

export const shellQuoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

const launcherNameOf = (platform: NodeJS.Platform, program: string): string => (platform === 'win32' ? `${program}.cmd` : program);

const launcherTextOf = (platform: NodeJS.Platform, main: string, items: string, program: string): string =>
  platform === 'win32'
    ? `@"${process.execPath}" "${main}" "${items}" ${program} %*\r\n`
    : `#!/bin/sh\nexec ${shellQuoted(process.execPath)} ${shellQuoted(main)} ${shellQuoted(items)} ${program} "$@"\n`;

export const installFakePrograms = (root: string, platform: NodeJS.Platform = process.platform): string => {
  const bin = path.join(root, 'bin');
  const items = path.join(root, 'items');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.mkdirSync(items, { recursive: true, mode: 0o700 });
  for (const { program, main } of STAND_INS) {
    fs.writeFileSync(path.join(bin, launcherNameOf(platform, program)), launcherTextOf(platform, main, items, program), { mode: 0o755 });
  }
  return bin;
};

export const fakeBrowserOf = (bin: string, platform: NodeJS.Platform = process.platform): string => path.join(bin, launcherNameOf(platform, BROWSER_STAND_IN));

const ROOT_PREFIX = 'momonga-secret-programs-';
const MARKER_FILE = '.momonga-fake-secret-programs';
const ROOT_ENTRIES = [MARKER_FILE, 'bin', 'items'].sort();

export type FakePrograms = { root: string; bin: string; token: string };

type Marker = { token: string; root: string };

export const createFakePrograms = (): FakePrograms => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), ROOT_PREFIX)));
  fs.chmodSync(root, 0o700);
  const bin = installFakePrograms(root);
  const marker: Marker = { token: randomBytes(32).toString('hex'), root };
  fs.writeFileSync(path.join(root, MARKER_FILE), JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
  return { root, bin, token: marker.token };
};

const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

const isCreatedWith = (root: string, token: string): boolean => {
  if (!TOKEN_SHAPE.test(token)) return false;
  let real: string;
  try {
    real = fs.realpathSync(root);
  } catch {
    return false;
  }
  if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith(ROOT_PREFIX)) return false;
  if (JSON.stringify(fs.readdirSync(real).sort()) !== JSON.stringify(ROOT_ENTRIES)) return false;
  const marker = JSON.parse(fs.readFileSync(path.join(real, MARKER_FILE), 'utf8')) as Partial<Marker>;
  return marker.root === real && typeof marker.token === 'string' && TOKEN_SHAPE.test(marker.token) && timingSafeEqual(Buffer.from(marker.token), Buffer.from(token));
};

export const removeFakePrograms = (root: string, token: string): void => {
  if (!isCreatedWith(root, token)) throw new Error(`${root} is not a fake programs directory this token created`);
  fs.rmSync(fs.realpathSync(root), { recursive: true, force: true });
};

export const posixEnvLine = (bin: string): string => `PATH=${shellQuoted(bin)}:"$PATH" BROWSER=${shellQuoted(fakeBrowserOf(bin))}; export PATH BROWSER`;

export const testHostPath = (base: string = MINIMAL_CHILD_PATH): string => `${fakeSecretProgramsBin()}${path.delimiter}${base}`;

const CONTROL_FILE = '.control';
const ENDED_FILE = '.ended';
const HANGING_FILE = '.hanging';
const LOGIN_KEYCHAIN_FILE = '.login.keychain-db';
const MISSING_KEYCHAIN_FILE = '.missing.keychain-db';

const itemsOf = (bin: string): string => path.join(path.dirname(bin), 'items');

export const fakeOpenerRecordOf = (bin: string): string => openerRecordIn(itemsOf(bin));

export const writeFakeSecretItem = (bin: string, name: string, value: string): void => {
  fs.writeFileSync(path.join(itemsOf(bin), name), value, { mode: 0o600 });
};

const textOrUndefined = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

export const readFakeSecretControl = (items: string): FakeControl => {
  const file = path.join(items, CONTROL_FILE);
  const text = textOrUndefined(file);
  if (text === undefined) return READY_CONTROL;
  const { readiness, calls } = JSON.parse(text) as Partial<FakeControl>;
  if (readiness === undefined || !FAKE_READINESS_VALUES.includes(readiness) || calls === undefined || !FAKE_CALL_MODES.includes(calls)) {
    throw new Error(`the fake secret control file ${file} does not hold a readiness and a call mode: ${text}`);
  }
  return { readiness, calls };
};

export const setFakeSecretControl = (control: Partial<FakeControl>, bin: string): void => {
  const items = itemsOf(bin);
  const staging = path.join(items, `${CONTROL_FILE}.${process.pid}.${randomBytes(8).toString('hex')}`);
  fs.writeFileSync(staging, JSON.stringify({ ...READY_CONTROL, ...control }), { mode: 0o600, flag: 'wx' });
  fs.renameSync(staging, path.join(items, CONTROL_FILE));
};

export const resetFakeSecretControl = (bin: string): void => {
  fs.rmSync(path.join(itemsOf(bin), CONTROL_FILE), { force: true });
};

const linesOf = (file: string): string[] => (textOrUndefined(file) ?? '').split('\n').filter((line) => line !== '');

const appendLine = (file: string, words: readonly string[]): void => {
  fs.appendFileSync(file, `${words.join(' ')}\n`, { mode: 0o600 });
};

export const getFakeSecretEnded = (bin: string): string[] => linesOf(path.join(itemsOf(bin), ENDED_FILE));

export const getFakeSecretHanging = (bin: string): string[] => linesOf(path.join(itemsOf(bin), HANGING_FILE));

export const recordFakeSecretEnded = (items: string, program: string, args: readonly string[]): void => {
  appendLine(path.join(items, ENDED_FILE), ['ended', program, ...args]);
};

export const recordFakeSecretHanging = (items: string, program: string, args: readonly string[]): void => {
  appendLine(path.join(items, HANGING_FILE), ['hanging', program, ...args]);
};

const fakeLoginKeychainOf = (items: string): string => path.join(items, LOGIN_KEYCHAIN_FILE);

export const fakeMissingKeychainOf = (items: string): string => path.join(items, MISSING_KEYCHAIN_FILE);

export const createFakeLoginKeychain = (items: string): string => {
  const file = fakeLoginKeychainOf(items);
  try {
    fs.writeFileSync(file, '', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return file;
};
