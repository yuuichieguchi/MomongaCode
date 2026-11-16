import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { systemTempRoot, tempDirPrefixFor, TEST_RUN_ENV, testTempBases } from '@momonga/testkit';
import { TEMP_LEDGER_ENV, readTempLedger } from './temp-ledger.ts';
import type { TempEntry } from './temp-ledger.ts';

export const UNRECORDED_CREATOR = 'made by no recorded test';

export const leakedTempDirs = (tmpRoot: string, token: string): string[] => {
  const prefix = tempDirPrefixFor(token);
  return fs
    .readdirSync(tmpRoot)
    .filter((entry) => entry.startsWith(prefix))
    .sort();
};

const isUnder = (root: string, entry: string): boolean => {
  const relative = path.relative(root, entry);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const stillExists = (entry: string): boolean => fs.lstatSync(entry, { throwIfNoEntry: false }) !== undefined;

export const leakedTempEntries = (tmpRoots: readonly string[], token: string, recorded: readonly TempEntry[]): string[] => {
  const carryingToken = tmpRoots.flatMap((tmpRoot) => leakedTempDirs(tmpRoot, token).map((entry) => path.join(tmpRoot, entry)));
  const recordedAndLeft = recorded.map((entry) => entry.path).filter((entry) => tmpRoots.some((tmpRoot) => isUnder(tmpRoot, entry)) && stillExists(entry));
  return [...new Set([...carryingToken, ...recordedAndLeft])];
};

const creatorsOf = (recorded: readonly TempEntry[]): ReadonlyMap<string, string> =>
  new Map(recorded.flatMap((entry) => (entry.creator === undefined ? [] : [[entry.path, entry.creator] as const])));

export const assertNoLeakedTempDirs = (tmpRoots: readonly string[], token: string, recorded: readonly TempEntry[]): void => {
  const leaked = leakedTempEntries(tmpRoots, token, recorded);
  if (leaked.length === 0) return;
  const creators = creatorsOf(recorded);
  const named = leaked.map((entry) => {
    const creator = creators.get(entry);
    return `${entry} (${creator === undefined ? UNRECORDED_CREATOR : `made by ${creator}`})`;
  });
  const failure = new Error(`test run ${token} left ${leaked.length} temp dir(s): ${named.join(', ')}`);
  for (const entry of leaked) fs.rmSync(entry, { recursive: true, force: true });
  throw failure;
};

export const newRunToken = (): string => randomBytes(2).toString('hex');

const ledgerOf = (ledgerDir: string, token: string): string => path.join(ledgerDir, `${tempDirPrefixFor(token)}ledger`);

export const claimRunToken = (ledgerDir: string, candidate: () => string): { token: string; ledger: string } => {
  for (;;) {
    const token = candidate();
    const ledger = ledgerOf(ledgerDir, token);
    try {
      fs.writeFileSync(ledger, '', { mode: 0o600, flag: 'wx' });
      return { token, ledger };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
};

export default function setup(): () => void {
  const { token, ledger } = claimRunToken(systemTempRoot(), newRunToken);
  process.env[TEST_RUN_ENV] = token;
  process.env[TEMP_LEDGER_ENV] = ledger;
  const tmpRoots = testTempBases();
  return () => {
    const recorded = readTempLedger(ledger);
    fs.rmSync(ledger);
    assertNoLeakedTempDirs(tmpRoots, token, recorded);
  };
}
