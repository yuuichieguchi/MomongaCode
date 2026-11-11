import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PreconditionFailedError, loadProbeRecord, resolveToolCalling, saveProbeRecord } from '@momonga/gateway';
import { makeReport } from './report-fixture.ts';
import type { KnownProbeKey } from '@momonga/config';
import { FM_CURRENCY, fmRecordKey } from './fm-record-support.ts';
import { testKernelLock } from '@momonga/testkit';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  fs.chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
};

const key: KnownProbeKey = fmRecordKey('a'.repeat(64), '27A100');
const TARGET = 'apple';

const fileOf = (dir: string, of: KnownProbeKey): string => path.join(dir, `${of.digest}.json`);

describe('probe records (design-managed-servers section 6.6: one file per key, named by the key digest)', () => {
  it('writes <dir>/<key digest>.json with mode 0600 and loads it back', async () => {
    const dir = makeDir();
    const report = makeReport(0.95, 1);
    await saveProbeRecord(dir, key, report, FM_CURRENCY, testKernelLock());
    expect(fs.statSync(fileOf(dir, key)).mode & 0o777).toBe(0o600);
    expect(await loadProbeRecord(dir, key, FM_CURRENCY, TARGET)).toEqual(report);
  });

  it('creates the directory when it does not exist', async () => {
    const dir = path.join(makeDir(), 'probes');
    await saveProbeRecord(dir, key, makeReport(1, 1), FM_CURRENCY, testKernelLock());
    expect(fs.statSync(fileOf(dir, key)).isFile()).toBe(true);
  });

  it('returns null when the record is missing', async () => {
    expect(await loadProbeRecord(makeDir(), key, FM_CURRENCY, TARGET)).toBeNull();
  });

  it.each([
    ['the binary hash', fmRecordKey('b'.repeat(64), '27A100')],
    ['the OS build', fmRecordKey('a'.repeat(64), '27A200')],
    ['the declared model', fmRecordKey('a'.repeat(64), '27A100', 'another-model')],
  ])('reads no record when %s differs', async (_label, other) => {
    const dir = makeDir();
    await saveProbeRecord(dir, key, makeReport(1, 1), FM_CURRENCY, testKernelLock());
    expect(await loadProbeRecord(dir, other, FM_CURRENCY, TARGET)).toBeNull();
  });

  it('reads no record whose description digest differs', async () => {
    const dir = makeDir();
    await saveProbeRecord(dir, key, makeReport(1, 1), FM_CURRENCY, testKernelLock());
    expect(await loadProbeRecord(dir, key, { ...FM_CURRENCY, descriptionDigest: 'c'.repeat(64) }, TARGET)).toBeNull();
  });

  it('keeps records of different keys apart', async () => {
    const dir = makeDir();
    const other = fmRecordKey('a'.repeat(64), '27A100', 'other');
    const fmReport = makeReport(1, 1);
    const otherReport = makeReport(0, 1);
    await saveProbeRecord(dir, key, fmReport, FM_CURRENCY, testKernelLock());
    await saveProbeRecord(dir, other, otherReport, FM_CURRENCY, testKernelLock());
    expect(await loadProbeRecord(dir, key, FM_CURRENCY, TARGET)).toEqual(fmReport);
    expect(await loadProbeRecord(dir, other, FM_CURRENCY, TARGET)).toEqual(otherReport);
  });

  it('overwrites an existing record for the same key', async () => {
    const dir = makeDir();
    await saveProbeRecord(dir, key, makeReport(1, 1), FM_CURRENCY, testKernelLock());
    const newer = makeReport(0.5, 0.95);
    await saveProbeRecord(dir, key, newer, FM_CURRENCY, testKernelLock());
    expect(await loadProbeRecord(dir, key, FM_CURRENCY, TARGET)).toEqual(newer);
    expect(fs.statSync(fileOf(dir, key)).mode & 0o777).toBe(0o600);
  });
});

describe('probe record failure handling', () => {
  const recordFile = (dir: string): string => fileOf(dir, key);

  it('names the file, the remediation and the original error when the record is not JSON', async () => {
    const dir = makeDir();
    fs.writeFileSync(recordFile(dir), '{"key": ');
    const error = await loadProbeRecord(dir, key, FM_CURRENCY, TARGET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(recordFile(dir));
    expect(message).toContain(`momonga gateway probe ${TARGET}`);
    expect(message).toContain('Delete it');
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it('names the file and the remediation when the report does not match the schema', async () => {
    const dir = makeDir();
    await saveProbeRecord(dir, key, makeReport(1, 1), FM_CURRENCY, testKernelLock());
    const stored = JSON.parse(fs.readFileSync(recordFile(dir), 'utf8'));
    fs.writeFileSync(recordFile(dir), JSON.stringify({ ...stored, report: { probedAt: 'now', schemaDialect: stored.report.schemaDialect } }));
    const error = await loadProbeRecord(dir, key, FM_CURRENCY, TARGET).catch((e: unknown) => e);
    expect((error as Error).message).toContain(recordFile(dir));
    expect((error as Error).message).toContain(`momonga gateway probe ${TARGET}`);
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it('names the file when the record lacks its key fields', async () => {
    const dir = makeDir();
    fs.writeFileSync(recordFile(dir), JSON.stringify({ report: makeReport(1, 1) }));
    await expect(loadProbeRecord(dir, key, FM_CURRENCY, TARGET)).rejects.toThrow(recordFile(dir));
  });

  it('tightens the permissions of an existing directory to 0700', async () => {
    const dir = makeDir();
    fs.chmodSync(dir, 0o755);
    await saveProbeRecord(dir, key, makeReport(1, 1), FM_CURRENCY, testKernelLock());
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('removes the temporary file when the rename fails', async () => {
    const dir = makeDir();
    fs.mkdirSync(recordFile(dir));
    fs.writeFileSync(path.join(recordFile(dir), 'occupant'), 'x');
    await expect(saveProbeRecord(dir, key, makeReport(1, 1), FM_CURRENCY, testKernelLock())).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([path.basename(recordFile(dir))]);
  });
});

const needsProbe = { state: 'needs_probe' as const, message: 'the model "fm" sets toolCalling to auto, but no probe record exists', evidence: 'no record for the fm binary', remedy: 'run `momonga gateway probe fm`' };

describe('resolveToolCalling', () => {
  it('uses explicit native from config regardless of the record', () => {
    expect(resolveToolCalling('native', makeReport(0, 1), needsProbe)).toEqual({ mode: 'native', source: 'config' });
    expect(resolveToolCalling('native', null, needsProbe)).toEqual({ mode: 'native', source: 'config' });
  });

  it('uses explicit constrained from config regardless of the record', () => {
    expect(resolveToolCalling('constrained', makeReport(1, 0), needsProbe)).toEqual({ mode: 'constrained', source: 'config' });
    expect(resolveToolCalling('constrained', null, needsProbe)).toEqual({ mode: 'constrained', source: 'config' });
  });

  it('decides from the record under auto', () => {
    expect(resolveToolCalling('auto', makeReport(1, 1), needsProbe)).toEqual({ mode: 'native', source: 'probed' });
    expect(resolveToolCalling('auto', makeReport(0.5, 0.95), needsProbe)).toEqual({ mode: 'constrained', source: 'probed' });
    expect(resolveToolCalling('auto', makeReport(0.5, 0.5), needsProbe)).toEqual({ mode: 'none', source: 'probed' });
  });

  it('fails with precondition_failed and the probe remedy under auto without a record, and resolves no mode', () => {
    expect.assertions(4);
    try {
      resolveToolCalling('auto', null, needsProbe);
    } catch (error) {
      expect(error).toBeInstanceOf(PreconditionFailedError);
      expect((error as PreconditionFailedError).remediation).toBe(needsProbe.remedy);
      expect((error as PreconditionFailedError).message).toBe(needsProbe.message);
      expect((error as PreconditionFailedError).detail).toBe(needsProbe.evidence);
    }
  });
});
