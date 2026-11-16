import fs, { mkdtempSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { shortTempBase } from '@momonga/foundation';
import { TEST_RUN_ENV, testRunToken, testTempBases, withTempDir } from '@momonga/testkit';
import { UNRECORDED_CREATOR, assertNoLeakedTempDirs, claimRunToken, leakedTempDirs, leakedTempEntries, newRunToken } from './support/leak-guard.ts';
import { TEMP_LEDGER_ENV, creatorOf, readTempLedger, recordTempEntry } from './support/temp-ledger.ts';
import type { TempEntry } from './support/temp-ledger.ts';

const madeBy = (entry: string, creator: string): TempEntry => ({ path: entry, creator });

describe('leak guard', () => {
  it('generates a four-hex run token', () => {
    expect(newRunToken()).toMatch(/^[0-9a-f]{4}$/);
  });

  it('lists only directories carrying this run token', (context) => {
    const root = withTempDir(context);
    for (const name of ['mmt-abcd-111111', 'mmt-abcd-222222', 'mmt-ffff-333333', 'mm-abcd-444444', 'mmt-abcde-55555']) {
      fs.mkdirSync(path.join(root, name));
    }
    expect(leakedTempDirs(root, 'abcd')).toEqual(['mmt-abcd-111111', 'mmt-abcd-222222']);
  });

  it('fails naming the leaked directories of its run, and removes them once they are named', (context) => {
    const root = withTempDir(context);
    fs.mkdirSync(path.join(root, 'mmt-abcd-111111'));
    fs.writeFileSync(path.join(root, 'mmt-abcd-111111', 'left'), 'planted');
    fs.mkdirSync(path.join(root, 'mmt-ffff-333333'));
    expect(() => assertNoLeakedTempDirs([root], 'abcd', [])).toThrow(`test run abcd left 1 temp dir(s): ${path.join(root, 'mmt-abcd-111111')} (${UNRECORDED_CREATOR})`);
    expect(fs.readdirSync(root)).toEqual(['mmt-ffff-333333']);
  });

  it('passes when nothing of this run is left', (context) => {
    const root = withTempDir(context);
    fs.mkdirSync(path.join(root, 'mmt-ffff-333333'));
    expect(() => assertNoLeakedTempDirs([root], 'abcd', [])).not.toThrow();
  });

  it('names what is left in every base it is given', (context) => {
    const first = withTempDir(context);
    const second = withTempDir(context);
    fs.mkdirSync(path.join(first, 'mmt-abcd-111111'));
    fs.mkdirSync(path.join(second, 'mmt-abcd-222222'));
    expect(() => assertNoLeakedTempDirs([first, second], 'abcd', [])).toThrow(`${path.join(first, 'mmt-abcd-111111')} (${UNRECORDED_CREATOR}), ${path.join(second, 'mmt-abcd-222222')} (${UNRECORDED_CREATOR})`);
  });

  it('sweeps the base of homes and the base of other directories', () => {
    expect(testTempBases()).toEqual([...new Set([shortTempBase(process.platform, os.tmpdir()), os.tmpdir()].map((base) => fs.realpathSync(base)))]);
  });
});

describe('leak guard over the entries the run recorded', () => {
  it('fails naming an entry of another prefix that the run made and left under a temp base', (context) => {
    const root = withTempDir(context);
    const left = path.join(root, 'mm-left');
    fs.mkdirSync(left);
    expect(leakedTempEntries([root], 'abcd', [madeBy(left, 'a.test.ts'), madeBy(path.join(root, 'mm-removed'), 'a.test.ts')])).toEqual([left]);
    expect(() => assertNoLeakedTempDirs([root], 'abcd', [madeBy(left, 'packages/x/test/a.test.ts > makes a folder')])).toThrow(`test run abcd left 1 temp dir(s): ${left} (made by packages/x/test/a.test.ts > makes a folder)`);
    expect(fs.existsSync(left)).toBe(false);
  });

  it('names an entry once when it carries the run token and was recorded', (context) => {
    const root = withTempDir(context);
    const left = path.join(root, 'mmt-abcd-111111');
    fs.mkdirSync(left);
    expect(leakedTempEntries([root], 'abcd', [madeBy(left, 'a.test.ts'), madeBy(left, 'a.test.ts')])).toEqual([left]);
  });

  it('names a recorded entry left inside a directory of a temp base', (context) => {
    const root = withTempDir(context);
    const nested = path.join(root, 'kept', 'guard-nested');
    fs.mkdirSync(nested, { recursive: true });
    expect(leakedTempEntries([root], 'abcd', [madeBy(nested, 'a.test.ts')])).toEqual([nested]);
  });

  it('does not judge a recorded entry outside every temp base', (context) => {
    const base = withTempDir(context);
    const elsewhere = withTempDir(context);
    expect(leakedTempEntries([base], 'abcd', [madeBy(elsewhere, 'a.test.ts')])).toEqual([]);
  });
});

describe('the run token is claimed with the ledger of the run', () => {
  it('creates the ledger of the token, owner-only and empty', (context) => {
    const root = withTempDir(context);
    const claimed = claimRunToken(root, () => 'abcd');
    expect(claimed).toEqual({ token: 'abcd', ledger: path.join(root, 'mmt-abcd-ledger') });
    expect(fs.statSync(claimed.ledger).mode & 0o777).toBe(0o600);
    expect(readTempLedger(claimed.ledger)).toEqual([]);
  });

  it('takes another token when a run already holds the first', (context) => {
    const root = withTempDir(context);
    const tokens = ['abcd', 'abcd', 'ef01'];
    const first = claimRunToken(root, () => tokens.shift() as string);
    const second = claimRunToken(root, () => tokens.shift() as string);
    expect([first.token, second.token]).toEqual(['abcd', 'ef01']);
    expect(fs.readdirSync(root).sort()).toEqual(['mmt-abcd-ledger', 'mmt-ef01-ledger']);
  });

  it('reads back what was recorded, one entry per line, whatever characters the path holds', (context) => {
    const root = withTempDir(context);
    const { ledger } = claimRunToken(root, () => 'abcd');
    recordTempEntry(ledger, madeBy('/tmp/with space', 'a.test.ts > one'));
    recordTempEntry(ledger, { path: '/tmp/with\nnewline', creator: undefined });
    expect(readTempLedger(ledger)).toEqual([madeBy('/tmp/with space', 'a.test.ts > one'), { path: '/tmp/with\nnewline', creator: undefined }]);
  });
});

describe('the creator a ledger entry names', () => {
  const repository = '/repo';
  const stack = ['Error', '    at recorded (/repo/test/support/temp-entry-recorder.ts:30:5)', '    at createTempDir (/repo/packages/testkit/src/test-support.ts:111:30)', '    at startStack (/repo/packages/runtime/test/process/run-helpers.ts:40:7)', '    at /repo/packages/runtime/test/process/a.test.ts:9:3', '    at node:internal/x:1:1'].join('\n');

  it('names the test file and test while a test runs', () => {
    expect(creatorOf({ testPath: '/repo/packages/x/test/a.test.ts', currentTestName: 'makes a folder' }, stack, repository)).toBe('packages/x/test/a.test.ts > makes a folder');
  });

  it('names the call site in the repository when no test runs, past the recorder itself', () => {
    expect(creatorOf({ testPath: undefined, currentTestName: undefined }, stack, repository)).toBe('no running test, called from packages/runtime/test/process/run-helpers.ts:40');
  });
});

describe('the temp entry recorder of a worker', () => {
  const ledgerOfRun = (): string => {
    const ledger = process.env[TEMP_LEDGER_ENV];
    if (ledger === undefined) throw new Error(`${TEMP_LEDGER_ENV} is not set`);
    return ledger;
  };

  it('works on the ledger the run claimed with its token', () => {
    expect(path.basename(ledgerOfRun())).toBe(`mmt-${process.env[TEST_RUN_ENV]}-ledger`);
    expect(testTempBases()).toContain(path.dirname(ledgerOfRun()));
  });

  it.each([
    ['fs.mkdtempSync', (prefix: string) => fs.mkdtempSync(prefix)],
    ['the named mkdtempSync', (prefix: string) => mkdtempSync(prefix)],
    ['fs.mkdtemp with a callback', (prefix: string) => new Promise<string>((resolve, reject) => fs.mkdtemp(prefix, (error, dir) => (error === null ? resolve(dir) : reject(error))))],
    ['promisify(fs.mkdtemp)', (prefix: string) => promisify(fs.mkdtemp)(prefix)],
    ['fs.promises.mkdtemp', (prefix: string) => fs.promises.mkdtemp(prefix)],
    ['mkdtemp of node:fs/promises', (prefix: string) => mkdtemp(prefix)],
  ])('records an entry made with %s under a prefix without the run token, and the guard names it until it is removed', async (_form, make) => {
    const dir = await make(path.join(fs.realpathSync(os.tmpdir()), 'mm-'));
    try {
      expect(readTempLedger(ledgerOfRun())).toContainEqual({ path: dir, creator: `test/leak-guard.test.ts > ${expect.getState().currentTestName}` });
      expect(leakedTempEntries(testTempBases(), testRunToken(), readTempLedger(ledgerOfRun()))).toContain(dir);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
    expect(leakedTempEntries(testTempBases(), testRunToken(), readTempLedger(ledgerOfRun()))).not.toContain(dir);
  });
});

describe('the name of the run token variable has one writer', () => {
  const ROOT = path.resolve(import.meta.dirname, '..');
  const SPELT = new RegExp(`${TEST_RUN_ENV}\\b`);

  const sourcesUnder = (dir: string): string[] =>
    fs
      .readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
      .filter((name) => /\.(ts|tsx|mts|sh)$/.test(name) && !name.split(path.sep).includes('node_modules'))
      .map((name) => path.join(dir, name));

  it('test support, the formal harness, the scripts and the end-to-end support import it and never spell it', () => {
    expect(TEST_RUN_ENV).toBe(['MOMONGA', 'TEST', 'RUN'].join('_'));
    const spelling = ['test', 'scripts', 'e2e'].flatMap(sourcesUnder).filter((file) => SPELT.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(spelling).toEqual([]);
  });
});
