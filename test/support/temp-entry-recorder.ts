import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { expect } from 'vitest';
import { TEMP_LEDGER_ENV, recordTempEntry } from './temp-ledger.ts';

type Maker = (...args: unknown[]) => unknown;
type Holder = Record<string, unknown>;

const RECORDING = Symbol.for('momonga.tempEntryRecorder');

const ledgerOfRun = (): string => {
  const ledger = process.env[TEMP_LEDGER_ENV];
  if (ledger === undefined || ledger === '') throw new Error(`${TEMP_LEDGER_ENV} is not set; run through a vitest project with the leak-guard global setup`);
  return ledger;
};

const LEDGER = ledgerOfRun();

const pathOfMade = (made: unknown): string => (typeof made === 'object' && made !== null && 'path' in made ? String(made.path) : String(made));

const REPOSITORY = path.resolve(import.meta.dirname, '..', '..');

const creatorNow = (): string | undefined => {
  const { testPath, currentTestName } = expect.getState();
  if (testPath === undefined) return undefined;
  const file = path.relative(REPOSITORY, testPath).split(path.sep).join('/');
  return currentTestName === undefined ? file : `${file} > ${currentTestName}`;
};

const recorded = <T>(made: T): T => {
  recordTempEntry(LEDGER, { path: pathOfMade(made), creator: creatorNow() });
  return made;
};

const recordingCallback =
  (callback: Maker): Maker =>
  (error, made, ...rest) => {
    if (error === null || error === undefined) recorded(made);
    return callback(error, made, ...rest);
  };

const recordingSync = (make: Maker): Maker =>
  function recordingMake(this: unknown, ...args: unknown[]): unknown {
    return recorded(make.apply(this, args));
  };

const recordingWithCallback = (make: Maker): Maker =>
  function recordingMake(this: unknown, ...args: unknown[]): unknown {
    const callback = args.at(-1);
    return make.apply(this, typeof callback === 'function' ? [...args.slice(0, -1), recordingCallback(callback as Maker)] : args);
  };

const recordingPromised = (make: Maker): Maker =>
  async function recordingMake(this: unknown, ...args: unknown[]): Promise<unknown> {
    return recorded(await make.apply(this, args));
  };

const MAKERS: ReadonlyArray<readonly [holder: Holder, name: string, recording: (make: Maker) => Maker]> = [
  [fs as unknown as Holder, 'mkdtempSync', recordingSync],
  [fs as unknown as Holder, 'mkdtempDisposableSync', recordingSync],
  [fs as unknown as Holder, 'mkdtemp', recordingWithCallback],
  [fs.promises as unknown as Holder, 'mkdtemp', recordingPromised],
  [fs.promises as unknown as Holder, 'mkdtempDisposable', recordingPromised],
];

for (const [holder, name, recording] of MAKERS) {
  const original = holder[name] as (Maker & { [RECORDING]?: true }) | undefined;
  if (original === undefined || original[RECORDING] === true) continue;
  const replacement = recording(original);
  Object.defineProperty(replacement, RECORDING, { value: true });
  holder[name] = replacement;
}
syncBuiltinESMExports();
