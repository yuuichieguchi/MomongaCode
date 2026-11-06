import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAutoFitRecord } from '@momonga/config';
import { readAutoClassifierView } from '../../src/service/auto-classifier-view.ts';
import { FIT_KEY, failingRecord, passingRecord } from '../auto-fit-fixtures.ts';

const CAVEAT = 'auto reduces prompts but does not guarantee safety.';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const recordDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-fit-'));
  directories.push(directory);
  return directory;
};

const hex = (bytes: number): string => '0'.repeat(bytes * 2);

describe('the auto classifier view read at mode entry', () => {
  it('is not_measured with no record, and its detail names /auto-mode check', async () => {
    const view = await readAutoClassifierView({ alias: 'guard', key: FIT_KEY, directory: recordDirectory() });
    expect(view).toMatchObject({ alias: 'guard', measurement: 'not_measured' });
    expect(view.detail.startsWith('auto: classifier guard has not been measured for this version; run ')).toBe(true);
    expect(view.detail).toContain('auto-mode check');
    expect(view.detail.endsWith(CAVEAT)).toBe(true);
  });

  it('is passed with a matching passing record, stating its date and false allows', async () => {
    const directory = recordDirectory();
    await writeAutoFitRecord(directory, passingRecord(), hex);
    const view = await readAutoClassifierView({ alias: 'guard', key: FIT_KEY, directory });
    expect(view.measurement).toBe('passed');
    expect(view.detail).toContain('auto: classifier guard measured on 2026-11-06: passed (false allows 0/75, upper bound ');
    expect(view.detail.endsWith(CAVEAT)).toBe(true);
  });

  it('is did_not_pass with a matching failing record, naming the command for the report', async () => {
    const directory = recordDirectory();
    await writeAutoFitRecord(directory, failingRecord(), hex);
    const view = await readAutoClassifierView({ alias: 'guard', key: FIT_KEY, directory });
    expect(view.measurement).toBe('did_not_pass');
    expect(view.detail).toContain('auto: classifier guard measured on 2026-11-06: did not pass (');
    expect(view.detail).toContain('auto-mode check for the report');
    expect(view.detail.endsWith(CAVEAT)).toBe(true);
  });

  it('is not_measured when the only record has another key', async () => {
    const directory = recordDirectory();
    await writeAutoFitRecord(directory, passingRecord({ key: { ...FIT_KEY, datasetDigest: 'older-dataset' } }), hex);
    expect((await readAutoClassifierView({ alias: 'guard', key: FIT_KEY, directory })).measurement).toBe('not_measured');
  });
});
