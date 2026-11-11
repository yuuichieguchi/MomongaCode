import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { endpointIdentityOf, loadEndpointRecord, saveEndpointRecord, stableIdentityFieldsOf } from '@momonga/gateway';
import { makeDir } from './gateway-helpers.ts';
import { makeReport } from './report-fixture.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';
import { testKernelLock } from '@momonga/testkit';

const KEY = { endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen3.8:27b' };

const FIELDS = ['created', 'id', 'object', 'owned_by'];

describe('endpointIdentityOf', () => {
  const entry = { id: 'qwen3.8:27b', object: 'model', created: 1_700_000_000, owned_by: 'library' };

  it('is the same for the same listed entry and differs when the server reports another value of a recorded field', () => {
    const first = endpointIdentityOf({ data: [entry] }, KEY.model, FIELDS);
    expect(endpointIdentityOf({ data: [{ ...entry }] }, KEY.model, FIELDS)).toBe(first);
    expect(endpointIdentityOf({ data: [{ ...entry, created: 1_800_000_000 }] }, KEY.model, FIELDS)).not.toBe(first);
  });

  it('ignores a field that is not recorded, whatever its value', () => {
    const first = endpointIdentityOf({ data: [entry] }, KEY.model, ['id', 'object', 'owned_by']);
    expect(endpointIdentityOf({ data: [{ ...entry, created: 1_800_000_000 }] }, KEY.model, ['id', 'object', 'owned_by'])).toBe(first);
  });

  it('ignores the other models the server lists and the order of the keys', () => {
    const first = endpointIdentityOf({ data: [entry] }, KEY.model, FIELDS);
    const reordered = { owned_by: 'library', created: 1_700_000_000, object: 'model', id: 'qwen3.8:27b' };
    expect(endpointIdentityOf({ data: [{ id: 'other', object: 'model' }, reordered] }, KEY.model, FIELDS)).toBe(first);
  });

  it('refuses to name an identity when the server does not list the model', () => {
    expect(() => endpointIdentityOf({ data: [{ id: 'other' }] }, KEY.model, FIELDS)).toThrow(/does not list/);
    expect(() => endpointIdentityOf(undefined, KEY.model, FIELDS)).toThrow(/does not list/);
  });
});

describe('stableIdentityFieldsOf', () => {
  const entry = { id: 'qwen3.8:27b', object: 'model', owned_by: 'library' };

  it('drops a field that changes between two reads, such as a creation time stamped at listing time', () => {
    const first = { data: [{ ...entry, created: 1_700_000_000 }] };
    const second = { data: [{ ...entry, created: 1_700_000_042 }] };
    expect(stableIdentityFieldsOf(first, second, KEY.model)).toEqual(['id', 'object', 'owned_by']);
  });

  it('keeps every field that is equal in both reads, nested ones included', () => {
    const detailed = { ...entry, created: 1_700_000_000, details: { digest: 'sha256:aa', size: 7 } };
    expect(stableIdentityFieldsOf({ data: [detailed] }, { data: [{ ...detailed }] }, KEY.model)).toEqual(['created', 'details', 'id', 'object', 'owned_by']);
  });

  it('keeps nothing when the model is missing from one of the reads', () => {
    expect(stableIdentityFieldsOf({ data: [entry] }, { data: [] }, KEY.model)).toEqual([]);
  });
});

describe('endpoint probe records', () => {
  it('stores the report under the endpoint and the model, with the identity the server showed', async () => {
    const dir = makeDir();
    const report = makeReport(1, 1);
    await saveEndpointRecord(dir, KEY, 'identity-1', ['id', 'owned_by'], report, CURRENT_DIALECTS, testKernelLock());

    expect(await loadEndpointRecord(dir, KEY, CURRENT_DIALECTS)).toEqual({ identity: 'identity-1', identityFields: ['id', 'owned_by'], report });
  });

  it('keeps one record per endpoint and model', async () => {
    const dir = makeDir();
    await saveEndpointRecord(dir, KEY, 'a', FIELDS, makeReport(1, 1), CURRENT_DIALECTS, testKernelLock());
    await saveEndpointRecord(dir, { ...KEY, model: 'other' }, 'b', FIELDS, makeReport(0.5, 1), CURRENT_DIALECTS, testKernelLock());
    await saveEndpointRecord(dir, { ...KEY, endpoint: 'http://127.0.0.1:8080/v1' }, 'c', FIELDS, makeReport(0.2, 1), CURRENT_DIALECTS, testKernelLock());

    expect((await loadEndpointRecord(dir, KEY, CURRENT_DIALECTS))?.identity).toBe('a');
    expect((await loadEndpointRecord(dir, { ...KEY, model: 'other' }, CURRENT_DIALECTS))?.identity).toBe('b');
    expect((await loadEndpointRecord(dir, { ...KEY, endpoint: 'http://127.0.0.1:8080/v1' }, CURRENT_DIALECTS))?.identity).toBe('c');
  });

  it('replaces the record of the same endpoint and model', async () => {
    const dir = makeDir();
    await saveEndpointRecord(dir, KEY, 'old', FIELDS, makeReport(1, 1), CURRENT_DIALECTS, testKernelLock());
    await saveEndpointRecord(dir, KEY, 'new', FIELDS, makeReport(1, 1), CURRENT_DIALECTS, testKernelLock());

    expect((await loadEndpointRecord(dir, KEY, CURRENT_DIALECTS))?.identity).toBe('new');
  });

  it('finds nothing when no record exists', async () => {
    expect(await loadEndpointRecord(makeDir(), KEY, CURRENT_DIALECTS)).toBeNull();
  });

  it('refuses a record that is not a valid probe report, naming the file', async () => {
    const dir = makeDir();
    await saveEndpointRecord(dir, KEY, 'a', FIELDS, makeReport(1, 1), CURRENT_DIALECTS, testKernelLock());
    const [file] = fs.readdirSync(dir);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, file as string), 'utf8'));
    fs.writeFileSync(path.join(dir, file as string), JSON.stringify({ ...stored, report: { nope: true, schemaDialect: stored.report.schemaDialect } }));

    await expect(loadEndpointRecord(dir, KEY, CURRENT_DIALECTS)).rejects.toThrow(file as string);
  });

  it('refuses a record whose identity fields are not a list of names, naming the file', async () => {
    const dir = makeDir();
    await saveEndpointRecord(dir, KEY, 'a', FIELDS, makeReport(1, 1), CURRENT_DIALECTS, testKernelLock());
    const [file] = fs.readdirSync(dir);
    const { identityFields: _identityFields, ...stored } = JSON.parse(fs.readFileSync(path.join(dir, file as string), 'utf8'));
    fs.writeFileSync(path.join(dir, file as string), JSON.stringify(stored));

    await expect(loadEndpointRecord(dir, KEY, CURRENT_DIALECTS)).rejects.toThrow(file as string);
  });

  it('is never keyed by a binary hash', async () => {
    const dir = makeDir();
    await saveEndpointRecord(dir, KEY, 'a', FIELDS, makeReport(1, 1), CURRENT_DIALECTS, testKernelLock());
    const [file] = fs.readdirSync(dir);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, file as string), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['dialectsDigest', 'endpoint', 'identity', 'identityFields', 'model', 'probeMethod', 'report']);
  });
});
