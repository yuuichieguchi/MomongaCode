import fs from 'node:fs';
import path from 'node:path';

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

export type TestState = { readonly testPath: string | undefined; readonly currentTestName: string | undefined };

const TESTKIT_SOURCES = 'packages/testkit/src/';

const RECORDING_FILES = ['test/support/temp-entry-recorder.ts', 'test/support/temp-ledger.ts'];

const repositoryRelative = (repository: string, file: string): string => path.relative(repository, file).split(path.sep).join('/');

const callSiteOf = (stack: string, repository: string): string | undefined =>
  stack
    .split('\n')
    .map((line) => /\(?((?:file:\/\/)?\/[^():]+):(\d+):\d+\)?$/.exec(line.trim()))
    .flatMap((match) => (match === null ? [] : [{ file: (match[1] ?? '').replace(/^file:\/\//, ''), line: match[2] ?? '' }]))
    .filter(({ file }) => file.startsWith(`${repository}${path.sep}`) && !file.includes(`${path.sep}node_modules${path.sep}`))
    .map(({ file, line }) => `${repositoryRelative(repository, file)}:${line}`)
    .filter((site) => !RECORDING_FILES.some((recording) => site.startsWith(`${recording}:`)))
    .reduce<string[]>((sites, site) => (sites.length > 0 && !(sites.at(-1) ?? '').startsWith(TESTKIT_SOURCES) ? sites : [...sites, site]), [])
    .at(-1);

export const creatorOf = (state: TestState, stack: string, repository: string): string => {
  const site = callSiteOf(stack, repository);
  if (state.testPath === undefined) return `no running test, called from ${site ?? 'outside the repository'}`;
  const file = repositoryRelative(repository, state.testPath);
  return state.currentTestName === undefined ? file : `${file} > ${state.currentTestName}`;
};
