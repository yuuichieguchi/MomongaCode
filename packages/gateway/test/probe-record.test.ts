import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PreconditionFailedError, loadProbeRecord, resolveToolCalling, saveProbeRecord } from '@momonga/gateway';
import { makeReport } from './report-fixture.ts';

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

const key = { target: 'fm', binarySha256: 'a'.repeat(64), osBuild: '27A100' };

describe('probe records', () => {
  it('writes <dir>/<target>.json with mode 0600 and loads it back', async () => {
    const dir = makeDir();
    const report = makeReport(0.95, 1);
    await saveProbeRecord(dir, key, report);
    const file = path.join(dir, 'fm.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(await loadProbeRecord(dir, key)).toEqual(report);
  });

  it('creates the directory when it does not exist', async () => {
    const dir = path.join(makeDir(), 'probes');
    await saveProbeRecord(dir, key, makeReport(1, 1));
    expect(fs.statSync(path.join(dir, 'fm.json')).isFile()).toBe(true);
  });

  it('returns null when the record is missing', async () => {
    expect(await loadProbeRecord(makeDir(), key)).toBeNull();
  });

  it('returns null when the binary hash differs', async () => {
    const dir = makeDir();
    await saveProbeRecord(dir, key, makeReport(1, 1));
    expect(await loadProbeRecord(dir, { ...key, binarySha256: 'b'.repeat(64) })).toBeNull();
  });

  it('returns null when the OS build differs', async () => {
    const dir = makeDir();
    await saveProbeRecord(dir, key, makeReport(1, 1));
    expect(await loadProbeRecord(dir, { ...key, osBuild: '27A200' })).toBeNull();
  });

  it('keeps records of different targets apart', async () => {
    const dir = makeDir();
    const fmReport = makeReport(1, 1);
    const otherReport = makeReport(0, 1);
    await saveProbeRecord(dir, key, fmReport);
    await saveProbeRecord(dir, { ...key, target: 'other' }, otherReport);
    expect(await loadProbeRecord(dir, key)).toEqual(fmReport);
    expect(await loadProbeRecord(dir, { ...key, target: 'other' })).toEqual(otherReport);
  });

  it('overwrites an existing record for the same target', async () => {
    const dir = makeDir();
    await saveProbeRecord(dir, key, makeReport(1, 1));
    const newer = makeReport(0.5, 0.95);
    await saveProbeRecord(dir, key, newer);
    expect(await loadProbeRecord(dir, key)).toEqual(newer);
    expect(fs.statSync(path.join(dir, 'fm.json')).mode & 0o777).toBe(0o600);
  });
});

describe('probe record failure handling', () => {
  const recordFile = (dir: string): string => path.join(dir, 'fm.json');

  it('names the file, the remediation and the original error when the record is not JSON', async () => {
    const dir = makeDir();
    fs.writeFileSync(recordFile(dir), '{"binarySha256": ');
    const error = await loadProbeRecord(dir, key).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(recordFile(dir));
    expect(message).toContain('momonga gateway probe fm');
    expect(message).toContain('Delete it');
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it('names the file and the remediation when the report does not match the schema', async () => {
    const dir = makeDir();
    fs.writeFileSync(
      recordFile(dir),
      JSON.stringify({ binarySha256: key.binarySha256, osBuild: key.osBuild, report: { probedAt: 'now' } }),
    );
    const error = await loadProbeRecord(dir, key).catch((e: unknown) => e);
    expect((error as Error).message).toContain(recordFile(dir));
    expect((error as Error).message).toContain('momonga gateway probe fm');
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it('names the file when the record lacks its key fields', async () => {
    const dir = makeDir();
    fs.writeFileSync(recordFile(dir), JSON.stringify({ report: makeReport(1, 1) }));
    await expect(loadProbeRecord(dir, key)).rejects.toThrow(recordFile(dir));
  });

  it('tightens the permissions of an existing directory to 0700', async () => {
    const dir = makeDir();
    fs.chmodSync(dir, 0o755);
    await saveProbeRecord(dir, key, makeReport(1, 1));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('removes the temporary file when the rename fails', async () => {
    const dir = makeDir();
    fs.mkdirSync(recordFile(dir));
    fs.writeFileSync(path.join(recordFile(dir), 'occupant'), 'x');
    await expect(saveProbeRecord(dir, key, makeReport(1, 1))).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual(['fm.json']);
  });
});

const needsProbe = { state: 'needs_probe' as const, message: 'the target "fm" sets toolCalling to auto, but no probe record exists', evidence: 'no record for the fm binary', remedy: 'run `momonga gateway probe fm`' };

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
