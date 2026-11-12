import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAutoFitRecord } from '@momonga/config';
import { readAutoClassifierView } from '../../src/service/auto-classifier-view.ts';
import { FIT_KEY, failingRecord, passingRecord } from '../auto-fit-fixtures.ts';
import { createTempDir, testKernelLock } from '@momonga/testkit';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const recordDirectory = (): string => {
  const directory = createTempDir();
  directories.push(directory);
  return directory;
};

const hex = (bytes: number): string => '0'.repeat(bytes * 2);

describe('the auto classifier view read at mode entry carries data, never text', () => {
  it('is not_measured with no record, carrying the key and no facts', async () => {
    const view = await readAutoClassifierView({ model: 'guard', key: FIT_KEY, directory: recordDirectory() });
    expect(view).toEqual({ model: 'guard', key: FIT_KEY, measurement: 'not_measured' });
  });

  it('is passed with a matching passing record, carrying its date, false allows, total and upper bound', async () => {
    const directory = recordDirectory();
    await writeAutoFitRecord(directory, passingRecord(), hex, testKernelLock());
    const view = await readAutoClassifierView({ model: 'guard', key: FIT_KEY, directory });
    expect(view).toEqual({ model: 'guard', key: FIT_KEY, measurement: 'passed', facts: { recordedAt: '2026-11-06T00:00:00.000Z', falseAllows: 0, total: 75, upperBound: 0.0487 } });
  });

  it('is did_not_pass with a matching failing record, carrying the bound that failed', async () => {
    const directory = recordDirectory();
    await writeAutoFitRecord(directory, failingRecord(), hex, testKernelLock());
    const view = await readAutoClassifierView({ model: 'guard', key: FIT_KEY, directory });
    expect(view).toEqual({ model: 'guard', key: FIT_KEY, measurement: 'did_not_pass', facts: { recordedAt: '2026-11-06T00:00:00.000Z', falseAllows: 1, total: 75, upperBound: 0.0721, failedBound: 'falseAllow' } });
  });

  it('is not_measured when the only record has another key', async () => {
    const directory = recordDirectory();
    await writeAutoFitRecord(directory, passingRecord({ key: { ...FIT_KEY, datasetDigest: 'older-dataset' } }), hex, testKernelLock());
    expect(await readAutoClassifierView({ model: 'guard', key: FIT_KEY, directory })).toEqual({ model: 'guard', key: FIT_KEY, measurement: 'not_measured' });
  });
});
