import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { endpointIdentityOf, loadEndpointRecord, saveEndpointRecord } from '@momonga/gateway';
import { makeDir } from './gateway-helpers.ts';
import { makeReport } from './report-fixture.ts';

const KEY = { endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen3.8:27b' };

describe('endpointIdentityOf', () => {
  const entry = { id: 'qwen3.8:27b', object: 'model', created: 1_700_000_000, owned_by: 'library' };

  it('is the same for the same listed entry and differs when the server reports another one', () => {
    const first = endpointIdentityOf({ data: [entry] }, KEY.model);
    expect(endpointIdentityOf({ data: [{ ...entry }] }, KEY.model)).toBe(first);
    expect(endpointIdentityOf({ data: [{ ...entry, created: 1_800_000_000 }] }, KEY.model)).not.toBe(first);
  });

  it('ignores the other models the server lists and the order of the keys', () => {
    const first = endpointIdentityOf({ data: [entry] }, KEY.model);
    const reordered = { owned_by: 'library', created: 1_700_000_000, object: 'model', id: 'qwen3.8:27b' };
    expect(endpointIdentityOf({ data: [{ id: 'other', object: 'model' }, reordered] }, KEY.model)).toBe(first);
  });

  it('is empty when the server does not list the model', () => {
    expect(endpointIdentityOf({ data: [{ id: 'other' }] }, KEY.model)).toBe('');
    expect(endpointIdentityOf(undefined, KEY.model)).toBe('');
  });
});

describe('endpoint probe records', () => {
  it('stores the report under the endpoint and the model, with the identity the server showed', async () => {
    const dir = makeDir();
    const report = makeReport(1, 1);
    await saveEndpointRecord(dir, KEY, 'identity-1', report);

    expect(await loadEndpointRecord(dir, KEY)).toEqual({ identity: 'identity-1', report });
  });

  it('keeps one record per endpoint and model', async () => {
    const dir = makeDir();
    await saveEndpointRecord(dir, KEY, 'a', makeReport(1, 1));
    await saveEndpointRecord(dir, { ...KEY, model: 'other' }, 'b', makeReport(0.5, 1));
    await saveEndpointRecord(dir, { ...KEY, endpoint: 'http://127.0.0.1:8080/v1' }, 'c', makeReport(0.2, 1));

    expect((await loadEndpointRecord(dir, KEY))?.identity).toBe('a');
    expect((await loadEndpointRecord(dir, { ...KEY, model: 'other' }))?.identity).toBe('b');
    expect((await loadEndpointRecord(dir, { ...KEY, endpoint: 'http://127.0.0.1:8080/v1' }))?.identity).toBe('c');
  });

  it('replaces the record of the same endpoint and model', async () => {
    const dir = makeDir();
    await saveEndpointRecord(dir, KEY, 'old', makeReport(1, 1));
    await saveEndpointRecord(dir, KEY, 'new', makeReport(1, 1));

    expect((await loadEndpointRecord(dir, KEY))?.identity).toBe('new');
  });

  it('finds nothing when no record exists', async () => {
    expect(await loadEndpointRecord(makeDir(), KEY)).toBeNull();
  });

  it('refuses a record that is not a valid probe report, naming the file', async () => {
    const dir = makeDir();
    await saveEndpointRecord(dir, KEY, 'a', makeReport(1, 1));
    const [file] = fs.readdirSync(dir);
    fs.writeFileSync(path.join(dir, file as string), JSON.stringify({ endpoint: KEY.endpoint, model: KEY.model, identity: 'a', report: { nope: true } }));

    await expect(loadEndpointRecord(dir, KEY)).rejects.toThrow(file as string);
  });

  it('is never keyed by a binary hash', async () => {
    const dir = makeDir();
    await saveEndpointRecord(dir, KEY, 'a', makeReport(1, 1));
    const [file] = fs.readdirSync(dir);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, file as string), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['endpoint', 'identity', 'model', 'report']);
  });
});
