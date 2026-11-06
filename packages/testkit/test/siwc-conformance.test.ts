import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PLAN_ERROR_CODES,
  PLAN_UNSUPPORTED_FIELDS,
  PLAN_UNSUPPORTED_TOOL_TYPES,
  SIWC_REFRESH_ERRORS,
  planErrorHttpReply,
  planErrorStreamReply,
  startFakePlanResponses,
} from '../src/index.ts';
import type { FakePlanResponses } from '../src/index.ts';

type Fixture = {
  admission: Array<{ status: number; quotedRow: string }>;
  structured: Array<{ codes: string[]; status: number; quotedRow: string }>;
  piOnly: { codes: string[]; status: null; source: string };
  refreshErrors: { unusable: string[]; invalidClient: string[]; quotedRow: string };
  unsupportedFields: { fields: string[] };
  unsupportedTools: { types: string[] };
  tokenResponse: { fields: string[]; expiresIn: number };
  models: { listKey: string };
};

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'plan-error-codes.json'), 'utf8')) as Fixture;
const constants = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'protocol', 'src', 'plan-constants.json'), 'utf8')) as {
  terminalCodes: string[];
  configurationCodes: string[];
};

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const play = async (reply: ReturnType<typeof planErrorHttpReply>): Promise<{ status: number; code: string }> => {
  const server: FakePlanResponses = await startFakePlanResponses({ verifyBearer: () => 'valid', script: [reply] });
  closers.push(() => server.close());
  const response = await fetch(`${server.origin}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer any' },
    body: JSON.stringify({ model: 'm', input: [{ role: 'user', content: 'hi' }], store: false, stream: true }),
  });
  const body = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: body.error.code };
};

const playInStream = async (reply: ReturnType<typeof planErrorStreamReply>): Promise<string> => {
  const server: FakePlanResponses = await startFakePlanResponses({ verifyBearer: () => 'valid', script: [reply] });
  closers.push(() => server.close());
  const response = await fetch(`${server.origin}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer any' },
    body: JSON.stringify({ model: 'm', input: [{ role: 'user', content: 'hi' }], store: false, stream: true }),
  });
  const text = await response.text();
  const failed = text.split('\n\n').find((block) => block.includes('event: response.failed')) ?? '';
  const data = failed.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? '{}';
  return (JSON.parse(data) as { response: { error: { code: string } } }).response.error.code;
};

describe('the fake against the evidence table (I-E1 fixture)', () => {
  const documented = fixture.structured.flatMap((row) => row.codes.map((code) => ({ code, status: row.status })));

  it('catalogues exactly the codes of the errors-and-recovery table plus the pi-only code, once each', () => {
    const catalogued = PLAN_ERROR_CODES.map((entry) => entry.code);
    expect(new Set(catalogued).size).toBe(catalogued.length);
    expect([...catalogued].sort()).toEqual([...documented.map((row) => row.code), ...fixture.piOnly.codes].sort());
  });

  it.each(documented.map((row) => [row.code, row.status] as const))('gives %s the documented status %i', (code, status) => {
    expect(PLAN_ERROR_CODES.find((entry) => entry.code === code)?.status).toBe(status);
  });

  it('leaves the status of the pi-only code open, as the pages do', () => {
    for (const code of fixture.piOnly.codes) expect(PLAN_ERROR_CODES.find((entry) => entry.code === code)?.status).toBeNull();
  });

  it('plays every documented code on both arrival paths with the same code and, over HTTP, the documented status', async () => {
    for (const row of documented) {
      expect(await play(planErrorHttpReply(row.code, {})), row.code).toEqual({ status: row.status, code: row.code });
      expect(await playInStream(planErrorStreamReply(row.code, {})), row.code).toBe(row.code);
    }
    for (const code of fixture.piOnly.codes) {
      expect(await play(planErrorHttpReply(code, { status: 429 }))).toEqual({ status: 429, code });
      expect(await playInStream(planErrorStreamReply(code, {}))).toBe(code);
    }
  });

  it('has a row with quoted text for every status and code it takes from the pages', () => {
    for (const row of [...fixture.structured, ...fixture.admission]) expect(row.quotedRow.length).toBeGreaterThan(20);
    expect(fixture.admission.map((row) => row.status)).toEqual([401, 403, 503]);
  });

  it('rejects exactly the fields, and refuses exactly the tool types, that the preview-limitations page lists', () => {
    expect([...PLAN_UNSUPPORTED_FIELDS].sort()).toEqual([...fixture.unsupportedFields.fields].sort());
    expect([...PLAN_UNSUPPORTED_TOOL_TYPES].sort()).toEqual([...fixture.unsupportedTools.types].sort());
  });

  it('scripts exactly the refresh errors of the page, and the product constants agree with them', () => {
    expect([...SIWC_REFRESH_ERRORS.unusable].sort()).toEqual([...fixture.refreshErrors.unusable].sort());
    expect([...SIWC_REFRESH_ERRORS.invalidClient]).toEqual(fixture.refreshErrors.invalidClient);
    expect([...constants.terminalCodes].sort()).toEqual([...fixture.refreshErrors.unusable].sort());
    expect(constants.configurationCodes).toEqual(fixture.refreshErrors.invalidClient);
  });

  it('keeps the shape of the token response and of the model list the pages state', () => {
    expect(fixture.tokenResponse.fields).toHaveLength(7);
    expect(fixture.tokenResponse.expiresIn).toBe(3600);
    expect(fixture.models.listKey).toBe('models');
  });
});
