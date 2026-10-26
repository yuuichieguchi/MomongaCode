import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';

export const TEST_API_KEY = 'momonga-test-api-key';
export const TEST_API_KEY_ENV = 'MOMONGA_TEST_KEY';
export const REDACTED = '[REDACTED]';
export const REDACTED_401 = `the upstream responded with HTTP 401: Incorrect API key provided: ${REDACTED}`;
export const CREDENTIAL_WINDOW = 8;
export const SK = 'sk' + '-';

export const credentialWindows = (key: string): string[] =>
  Array.from({ length: Math.max(0, key.length - CREDENTIAL_WINDOW + 1) }, (_, index) => key.slice(index, index + CREDENTIAL_WINDOW));

export const expectNoCredential = (text: string, key: string): void => {
  const leaked = credentialWindows(key).filter((window) => text.includes(window));
  expect(leaked, `credential windows leaked into: ${text.slice(0, 300)}`).toEqual([]);
};

export const expectRedacted = (text: string, key: string): void => {
  expectNoCredential(text, key);
  expect(text).toContain(REDACTED);
};

const filesUnder = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return filesUnder(full);
        return entry.isFile() ? [full] : [];
      })
    : [];

export const databaseFilesUnder = (dir: string): string[] => filesUnder(dir).filter((file) => /\.(db|sqlite)(-wal|-shm|-journal)?$/.test(file));

export const expectFilesFreeOfCredential = (files: readonly string[], key: string): void => {
  for (const file of files) expectNoCredential(fs.readFileSync(file).toString('latin1'), key);
};
