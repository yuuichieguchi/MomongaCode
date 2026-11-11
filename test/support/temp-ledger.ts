import fs from 'node:fs';

export const TEMP_LEDGER_ENV = 'MOMONGA_TEST_TEMP_LEDGER';

const appendFileSync = fs.appendFileSync;
const readFileSync = fs.readFileSync;

export const recordTempEntry = (ledger: string, entry: string): void => {
  appendFileSync(ledger, `${JSON.stringify(entry)}\n`);
};

const entryOf = (line: string, ledger: string): string => {
  const entry: unknown = JSON.parse(line);
  if (typeof entry !== 'string') throw new Error(`the temp ledger ${ledger} holds a line that is not a path: ${line}`);
  return entry;
};

export const readTempLedger = (ledger: string): string[] =>
  readFileSync(ledger, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => entryOf(line, ledger));
