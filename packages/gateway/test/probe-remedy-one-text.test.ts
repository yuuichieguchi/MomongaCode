import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { endpointRecordFileName, loadEndpointRecord, loadProbeRecord, managedRecordPath } from '@momonga/gateway';
import { remedyOf } from '../src/probe/remedy.ts';
import { makeDir } from './gateway-helpers.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';
import { FM_CURRENCY, fmRecordKey } from './fm-record-support.ts';

const ENDPOINT_KEY = { endpoint: 'http://127.0.0.1:1234/v1', model: 'qwen3.8:27b' };
const MANAGED_KEY = fmRecordKey('a'.repeat(64), '27A100');

const refusalOf = (pending: Promise<unknown>): Promise<string> =>
  pending.then(
    () => '',
    (error: unknown) => String(error),
  );

describe('one remedy text for every probe record that cannot be used', () => {
  it('names the model in the one probe command for a managed and an endpoint record alike', async () => {
    const dir = makeDir();
    fs.writeFileSync(managedRecordPath(dir, MANAGED_KEY), 'not json', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, endpointRecordFileName(ENDPOINT_KEY)), 'not json', { mode: 0o600 });

    const managed = await refusalOf(loadProbeRecord(dir, MANAGED_KEY, FM_CURRENCY, 'apple/fm'));
    const endpoint = await refusalOf(loadEndpointRecord(dir, ENDPOINT_KEY, CURRENT_DIALECTS, 'lmstudio/qwen3.8:27b'));

    expect(managed).toContain(remedyOf('apple/fm'));
    expect(endpoint).toContain(remedyOf('lmstudio/qwen3.8:27b'));
    expect(managed.replace('apple/fm', 'X').replace(managedRecordPath(dir, MANAGED_KEY), 'F')).toBe(endpoint.replace('lmstudio/qwen3.8:27b', 'X').replace(path.join(dir, endpointRecordFileName(ENDPOINT_KEY)), 'F'));
  });
});
