import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { FIT_KEY, failingRecord, passingRecord } from '../auto-fit-fixtures.ts';
import type { AutoFitRecord } from '../auto-fit-fixtures.ts';
import { OTHER_MODEL_ID, startService } from './helpers.ts';

const seedRecords = (home: string, records: readonly AutoFitRecord[]): void => {
  const directory = path.join(momongaLayout(home).state, 'auto-fit');
  fs.mkdirSync(directory, { recursive: true });
  records.forEach((record, index) => fs.writeFileSync(path.join(directory, `record-${index}.json`), JSON.stringify(record)));
};

const RECORD_SETS: [string, readonly AutoFitRecord[]][] = [
  ['no record', []],
  ['a failing record', [failingRecord()]],
  ['a passing record', [passingRecord()]],
  ['a stale and a failing record', [passingRecord({ key: { ...FIT_KEY, codeDigest: 'older' } }), failingRecord({ unobserved: 100 })]],
];

describe('auto is selectable independently of any measurement record (I6.6)', () => {
  it.each(RECORD_SETS)('creates a session in auto with %s', async (_label, records) => {
    const env = await startService();
    seedRecords(env.layout.home, records);
    env.ports.settingsByCwd.set(env.layout.projectReal, { autoModeClassifier: OTHER_MODEL_ID });
    const response = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, permissionMode: 'auto' } });
    expect(response.status).toBe(201);
    expect(response.json.session.permissionMode).toBe('auto');
  });

  it.each(RECORD_SETS)('changes a session to auto by PATCH with %s', async (_label, records) => {
    const env = await startService();
    seedRecords(env.layout.home, records);
    env.ports.settingsByCwd.set(env.layout.projectReal, { autoModeClassifier: OTHER_MODEL_ID });
    const session = await env.createSession();
    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'auto' } });
    expect(patched.status).toBe(200);
    expect(patched.json.session.permissionMode).toBe('auto');
  });
});
