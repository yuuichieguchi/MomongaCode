import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINIMAL_CHILD_PATH } from '@momonga/foundation';

export const TEST_SECRET_PROGRAMS_ENV = 'MOMONGA_TEST_SECRET_PROGRAMS';

const FAKE_SECURITY_MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-security-main.ts');

const shellQuoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

export const installFakeSecretPrograms = (root: string): string => {
  const bin = path.join(root, 'bin');
  const items = path.join(root, 'items');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.mkdirSync(items, { recursive: true, mode: 0o700 });
  const script = `#!/bin/sh\nexec ${shellQuoted(process.execPath)} ${shellQuoted(FAKE_SECURITY_MAIN)} ${shellQuoted(items)} "$@"\n`;
  fs.writeFileSync(path.join(bin, 'security'), script, { mode: 0o755 });
  return bin;
};

export const fakeSecretProgramsBin = (env: Readonly<Record<string, string | undefined>> = process.env): string => {
  const bin = env[TEST_SECRET_PROGRAMS_ENV];
  if (bin === undefined || bin === '') throw new Error(`${TEST_SECRET_PROGRAMS_ENV} is not set; the test run's global setup installs the fake secret store programs`);
  return bin;
};

export const testHostPath = (base: string = MINIMAL_CHILD_PATH): string => `${fakeSecretProgramsBin()}${path.delimiter}${base}`;
