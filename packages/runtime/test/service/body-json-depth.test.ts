import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { expectError, startService } from './helpers.ts';

const nestedArraysText = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

const runBodyText = (depth: number): string => `{"input":"x","extra":${nestedArraysText(depth - 1)}}`;

describe('Run API bodies and the one JSON depth bound', () => {
  it(`answers 400 naming the depth for a body nested ${MAX_JSON_DEPTH + 1} deep`, async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { raw: runBodyText(MAX_JSON_DEPTH + 1) });
    expectError(response, 400, 'invalid_request');
    const message = String(response.json?.error?.message);
    expect(message).toMatch(/depth/i);
    expect(message).toContain(String(MAX_JSON_DEPTH));
  });

  it(`passes a body nested exactly ${MAX_JSON_DEPTH} deep on to schema validation`, async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { raw: runBodyText(MAX_JSON_DEPTH) });
    expectError(response, 400, 'invalid_request');
    const message = String(response.json?.error?.message);
    expect(message).not.toMatch(/depth/i);
    expect(message).toMatch(/additional propert/i);
  });

  it(`answers 400 naming the depth for a session body nested ${MAX_JSON_DEPTH + 1} deep`, async () => {
    const env = await startService({ fakeTimers: true });
    const response = await env.http('POST', '/v1/sessions', { raw: `{"extra":${nestedArraysText(MAX_JSON_DEPTH)}}` });
    expectError(response, 400, 'invalid_request');
    const message = String(response.json?.error?.message);
    expect(message).toMatch(/depth/i);
    expect(message).toContain(String(MAX_JSON_DEPTH));
  });
});
