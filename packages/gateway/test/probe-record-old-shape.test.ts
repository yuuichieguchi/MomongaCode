import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProbeRecord, saveProbeRecord } from '../src/index.ts';
import { managedRecordPath } from '../src/probe/record.ts';
import { FM_CURRENCY, fmRecordKey } from './fm-record-support.ts';
import { makeDir } from './gateway-helpers.ts';
import { makeReport } from './report-fixture.ts';

const KEY = fmRecordKey('ef'.repeat(32), '25A100');

const savedRecord = async (): Promise<{ dir: string; file: string; stored: Record<string, unknown> }> => {
  const dir = path.join(makeDir(), 'probe');
  await saveProbeRecord(dir, KEY, makeReport(1, 1), FM_CURRENCY);
  const file = managedRecordPath(dir, KEY);
  return { dir, file, stored: JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> };
};

describe('a managed probe record of an earlier shape is no record (design-model-names 3.12)', () => {
  it('reads a record whose key text differs, or that has no descriptionDigest, as no record', async () => {
    const { dir, file, stored } = await savedRecord();
    fs.writeFileSync(file, JSON.stringify({ ...stored, key: 'target:fm' }));
    expect(await loadProbeRecord(dir, KEY, FM_CURRENCY, 'system')).toBeNull();
    const { descriptionDigest: _digest, ...withoutDigest } = stored;
    fs.writeFileSync(file, JSON.stringify(withoutDigest));
    expect(await loadProbeRecord(dir, KEY, FM_CURRENCY, 'system')).toBeNull();
  });

  it('reads a record with an equal key whatever name the model is shown under, because the key holds no name', async () => {
    const { dir, stored } = await savedRecord();
    expect(JSON.stringify(stored['key'])).not.toContain('apple');
    const before = await loadProbeRecord(dir, KEY, FM_CURRENCY, 'system');
    const afterRename = await loadProbeRecord(dir, KEY, FM_CURRENCY, 'my-mac/system');
    expect(before).not.toBeNull();
    expect(afterRename).toEqual(before);
  });

  it('keeps the sentence of an unreadable file, naming the model as the user types it', async () => {
    const { dir, file } = await savedRecord();
    fs.writeFileSync(file, '{ not json');
    await expect(loadProbeRecord(dir, KEY, FM_CURRENCY, 'system')).rejects.toThrow(
      `Probe record ${file} is unusable (not valid JSON). Delete it or run "/gateway probe system" in MomongaCode.`,
    );
  });
});
