import fs from 'node:fs';

export const TEMP_LEDGER_ENV = 'MOMONGA_TEST_TEMP_LEDGER';

export type TempEntry = { readonly path: string; readonly creator: string | undefined };

const appendFileSync = fs.appendFileSync;
const readFileSync = fs.readFileSync;

export const recordTempEntry = (ledger: string, entry: TempEntry): void => {
  appendFileSync(ledger, `${JSON.stringify(entry.creator === undefined ? { path: entry.path } : entry)}\n`);
};

const entryOf = (line: string, ledger: string): TempEntry => {
  const entry: unknown = JSON.parse(line);
  if (typeof entry !== 'object' || entry === null || !('path' in entry) || typeof entry.path !== 'string') {
    throw new Error(`the temp ledger ${ledger} holds a line that is not an entry: ${line}`);
  }
  if (!('creator' in entry)) return { path: entry.path, creator: undefined };
  if (typeof entry.creator !== 'string') throw new Error(`the temp ledger ${ledger} holds a creator that is not a string: ${line}`);
  return { path: entry.path, creator: entry.creator };
};

export const readTempLedger = (ledger: string): TempEntry[] =>
  readFileSync(ledger, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => entryOf(line, ledger));
