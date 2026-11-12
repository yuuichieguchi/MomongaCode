import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { endpointRecordFileName, loadEndpointRecord, loadProbeRecord, saveEndpointRecord, saveProbeRecord } from '@momonga/gateway';
import type { DialectDefinition, ProbeReport } from '@momonga/protocol';
import { PROBE_METHOD_VERSION } from '../src/probe/run-probe.ts';
import { makeReport } from './report-fixture.ts';
import type { KnownProbeKey } from '@momonga/config';
import { FM_CURRENCY, fmRecordKey } from './fm-record-support.ts';
import { createTempDir, testKernelLock } from '@momonga/testkit';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = createTempDir();
  fs.chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
};

const key: KnownProbeKey = fmRecordKey('a'.repeat(64), '27A100');
const endpointKey = { endpoint: 'unix:/tmp/fake.sock', model: 'qwen-fake' };

type Currency = { userDialects: Record<string, DialectDefinition>; probeMethod: number };

const NO_USER_DIALECTS: Currency = { userDialects: {}, probeMethod: PROBE_METHOD_VERSION };

const managedCurrency = (currency: Currency) => ({ ...currency, descriptionDigest: FM_CURRENCY.descriptionDigest });

const MINE: DialectDefinition = { rules: [{ select: [{ kinds: ['object-with-properties'] }], op: 'property-order', key: 'x-order' }] } as DialectDefinition;
const MINE_CHANGED: DialectDefinition = { rules: [{ select: [{ kinds: ['object-with-properties'] }], op: 'property-order', key: 'x-sequence' }] } as DialectDefinition;

const reportSelecting = (selected: string | null, tried: { id: string; result: 'accepted' | 'refused' }[]): ProbeReport =>
  ({ ...makeReport(1, 1), schemaDialect: { selected, shape: selected === null ? null : 'union', tried } }) as ProbeReport;

const SELECTED_2020 = reportSelecting('json-schema-2020-12', [{ id: 'json-schema-2020-12', result: 'accepted' }]);
const NONE_OF_BUILTINS = reportSelecting(null, [
  { id: 'json-schema-2020-12', result: 'refused' },
  { id: 'inlined-subset', result: 'refused' },
  { id: 'strict-closed', result: 'refused' },
  { id: 'explicit-keys', result: 'refused' },
]);
const NONE_WITH_MINE = reportSelecting(null, [...NONE_OF_BUILTINS.schemaDialect.tried.map(({ id, result }) => ({ id, result: result as 'refused' })), { id: 'mine', result: 'refused' }]);

const save = (dir: string, report: ProbeReport, currency: Currency) =>
  saveProbeRecord(dir, key, report, managedCurrency(currency), testKernelLock());
const load = (dir: string, currency: Currency) => loadProbeRecord(dir, key, managedCurrency(currency), 'apple');

const rewrite = (file: string, change: (stored: Record<string, unknown>) => Record<string, unknown>) => {
  fs.writeFileSync(file, JSON.stringify(change(JSON.parse(fs.readFileSync(file, 'utf8')))));
};

describe('record invalidation of the fm record (rule 7)', () => {
  it('is at probe method 4, the max concurrency recorded only from a refusal after the JSON-only mode step of method 3', () => {
    expect(PROBE_METHOD_VERSION).toBe(4);
  });

  it('reads a record stored under probe method 1 as no record', async () => {
    const dir = makeDir();
    await save(dir, SELECTED_2020, { ...NO_USER_DIALECTS, probeMethod: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${key.digest}.json`), 'utf8')).probeMethod).toBe(1);
    expect(await load(dir, NO_USER_DIALECTS)).toBeNull();
  });

  it('writes probeMethod and dialectsDigest beside the identity fields and loads the record back', async () => {
    const dir = makeDir();
    await save(dir, SELECTED_2020, NO_USER_DIALECTS);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, `${key.digest}.json`), 'utf8'));
    expect(stored.probeMethod).toBe(PROBE_METHOD_VERSION);
    expect(stored.dialectsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.report.schemaDialect).toEqual(SELECTED_2020.schemaDialect);
    expect(await load(dir, NO_USER_DIALECTS)).toEqual(SELECTED_2020);
  });

  it('reads a record written before the change, under the old target file name, as no record, without throwing (design 6.6, migration)', async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'fm.json'), JSON.stringify({ binarySha256: 'a'.repeat(64), osBuild: '27A100', report: makeReport(1, 1) }));
    expect(await load(dir, NO_USER_DIALECTS)).toBeNull();
  });

  it('reads a record of another probe method as no record', async () => {
    const dir = makeDir();
    await save(dir, SELECTED_2020, NO_USER_DIALECTS);
    rewrite(path.join(dir, `${key.digest}.json`), (stored) => ({ ...stored, probeMethod: PROBE_METHOD_VERSION + 1 }));
    expect(await load(dir, NO_USER_DIALECTS)).toBeNull();
  });

  it('reads a record whose digest no longer matches as no record', async () => {
    const dir = makeDir();
    await save(dir, SELECTED_2020, NO_USER_DIALECTS);
    rewrite(path.join(dir, `${key.digest}.json`), (stored) => ({ ...stored, dialectsDigest: '0'.repeat(64) }));
    expect(await load(dir, NO_USER_DIALECTS)).toBeNull();
  });

  it('stays current when a user dialect is added after the selected one', async () => {
    const dir = makeDir();
    await save(dir, SELECTED_2020, NO_USER_DIALECTS);
    expect(await load(dir, { userDialects: { mine: MINE }, probeMethod: PROBE_METHOD_VERSION })).toEqual(SELECTED_2020);
  });

  it('goes stale when a user dialect is added and none was selected', async () => {
    const dir = makeDir();
    await save(dir, NONE_OF_BUILTINS, NO_USER_DIALECTS);
    expect(await load(dir, NO_USER_DIALECTS)).toEqual(NONE_OF_BUILTINS);
    expect(await load(dir, { userDialects: { mine: MINE }, probeMethod: PROBE_METHOD_VERSION })).toBeNull();
  });

  it('goes stale when a rule of a tried user dialect changes', async () => {
    const dir = makeDir();
    await save(dir, NONE_WITH_MINE, { userDialects: { mine: MINE }, probeMethod: PROBE_METHOD_VERSION });
    expect(await load(dir, { userDialects: { mine: MINE }, probeMethod: PROBE_METHOD_VERSION })).toEqual(NONE_WITH_MINE);
    expect(await load(dir, { userDialects: { mine: MINE_CHANGED }, probeMethod: PROBE_METHOD_VERSION })).toBeNull();
  });
});

describe('record invalidation of the endpoint record (rule 7)', () => {
  const saveEndpoint = (dir: string, report: ProbeReport, currency: Currency) =>
    saveEndpointRecord(dir, endpointKey, 'identity', ['id'], report, currency, testKernelLock());
  const loadEndpoint = (dir: string, currency: Currency) =>
    loadEndpointRecord(dir, endpointKey, currency, 'the-model');
  const fileOf = (dir: string) => path.join(dir, endpointRecordFileName(endpointKey));

  it('writes both fields and loads the record back', async () => {
    const dir = makeDir();
    await saveEndpoint(dir, SELECTED_2020, NO_USER_DIALECTS);
    const stored = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
    expect(stored.probeMethod).toBe(PROBE_METHOD_VERSION);
    expect(stored.dialectsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect((await loadEndpoint(dir, NO_USER_DIALECTS))?.report).toEqual(SELECTED_2020);
  });

  it('reads a record without the fields as no record', async () => {
    const dir = makeDir();
    await saveEndpoint(dir, SELECTED_2020, NO_USER_DIALECTS);
    rewrite(fileOf(dir), ({ probeMethod: _method, dialectsDigest: _digest, ...rest }) => rest);
    expect(await loadEndpoint(dir, NO_USER_DIALECTS)).toBeNull();
  });

  it('reads a record stored under probe method 1 as no record', async () => {
    const dir = makeDir();
    await saveEndpoint(dir, SELECTED_2020, { ...NO_USER_DIALECTS, probeMethod: 1 });
    expect(JSON.parse(fs.readFileSync(fileOf(dir), 'utf8')).probeMethod).toBe(1);
    expect(await loadEndpoint(dir, NO_USER_DIALECTS)).toBeNull();
  });

  it('reads a record of another probe method as no record', async () => {
    const dir = makeDir();
    await saveEndpoint(dir, SELECTED_2020, NO_USER_DIALECTS);
    rewrite(fileOf(dir), (stored) => ({ ...stored, probeMethod: PROBE_METHOD_VERSION + 1 }));
    expect(await loadEndpoint(dir, NO_USER_DIALECTS)).toBeNull();
  });
});
