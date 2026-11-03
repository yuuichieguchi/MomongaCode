import { describe, expect, it } from 'vitest';
import { momongaPaths } from '@momonga/foundation';
import { MIN_SUMMARY_TOKENS } from '@momonga/protocol';
import { protectedRootAreasOf } from '@momonga/runtime';
import { createBuiltinTools, createGovernanceTools, createHistoryTools, createMemoryTools } from '@momonga/tools';
import { expectSchema, startService } from './helpers.ts';

const REPORT = { gate: 'PASS' };
const BIDIRECTIONAL_CONTROLS = ['061C', '200E', '200F', '202A', '202B', '202C', '202D', '202E', '2066', '2067', '2068', '2069'];

describe('the guideline routes', () => {
  it('lists nothing before the first adoption', async () => {
    const env = await startService();
    const listed = await env.http('GET', '/v1/guidelines');
    expect(listed.status).toBe(200);
    expect(listed.json).toEqual({ current: null, guidelines: [] });
    expectSchema('GuidelinesResponse', listed.json);
  });

  it('adopts a first guideline on no parent, then a second on the first, and lists both', async () => {
    const env = await startService();
    const first = await env.http('POST', '/v1/guidelines', { body: { text: 'keep names', parent: null, report: REPORT } });
    expect(first.status).toBe(201);
    expectSchema('GuidelineResponse', first.json);
    expect(first.json.guideline).toMatchObject({ version: 1, text: 'keep names', parent: null, report: REPORT });
    const second = await env.http('POST', '/v1/guidelines', { body: { text: 'keep paths', parent: 1, report: REPORT } });
    expect(second.json.guideline).toMatchObject({ version: 2, parent: 1 });
    const listed = await env.http('GET', '/v1/guidelines');
    expect(listed.json.current.version).toBe(2);
    expect(listed.json.guidelines.map((entry: { text: string }) => entry.text)).toEqual(['keep names', 'keep paths']);
    expectSchema('GuidelinesResponse', listed.json);
  });

  it('guards a lost update: an adoption on a stale parent is a 409 and stores nothing', async () => {
    const env = await startService();
    await env.http('POST', '/v1/guidelines', { body: { text: 'a', parent: null, report: REPORT } });
    const stale = await env.http('POST', '/v1/guidelines', { body: { text: 'b', parent: null, report: REPORT } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('guideline_conflict');
    expect(env.store.guidelines.list()).toHaveLength(1);
  });

  it('guards a guideline the summariser would refuse: text over the token cap is a 400 and stores nothing', async () => {
    const env = await startService();
    const response = await env.http('POST', '/v1/guidelines', { body: { text: 'あ'.repeat(MIN_SUMMARY_TOKENS + 1), parent: null, report: REPORT } });
    expect(response.status).toBe(400);
    expect(env.store.guidelines.list()).toEqual([]);
  });

  it.each([
    ['an escape sequence', 'keep names\u001b[2K'],
    ['a carriage return', 'keep names\rhide it'],
    ['a C1 control', 'keep\u009bnames'],
  ])('guards a text that hides itself on a terminal: %s is a 400 and stores nothing', async (_label, text) => {
    const env = await startService();
    const response = await env.http('POST', '/v1/guidelines', { body: { text, parent: null, report: REPORT } });
    expect(response.status).toBe(400);
    expect(env.store.guidelines.list()).toEqual([]);
  });

  it.each(BIDIRECTIONAL_CONTROLS)('guards a text that reorders itself on a terminal: U+%s is a 400 and stores nothing', async (hex) => {
    const env = await startService();
    const text = `keep${String.fromCodePoint(Number.parseInt(hex, 16))}names`;
    const response = await env.http('POST', '/v1/guidelines', { body: { text, parent: null, report: REPORT } });
    expect(response.status).toBe(400);
    expect(env.store.guidelines.list()).toEqual([]);
  });

  it('accepts a newline and a tab', async () => {
    const env = await startService();
    const response = await env.http('POST', '/v1/guidelines', { body: { text: 'keep names\n\tkeep paths', parent: null, report: REPORT } });
    expect(response.status).toBe(201);
  });

  it('rolls back to an earlier version as a new row, and refuses a version that does not exist', async () => {
    const env = await startService();
    await env.http('POST', '/v1/guidelines', { body: { text: 'a', parent: null, report: REPORT } });
    await env.http('POST', '/v1/guidelines', { body: { text: 'b', parent: 1, report: REPORT } });
    const back = await env.http('POST', '/v1/guidelines/1/rollback');
    expect(back.status).toBe(201);
    expect(back.json.guideline).toMatchObject({ version: 3, text: 'a', parent: 2, report: { rollbackTo: 1 } });
    expect((await env.http('POST', '/v1/guidelines/9/rollback')).status).toBe(404);
    expect((await env.http('POST', '/v1/guidelines/latest/rollback')).status).toBe(400);
  });
});

describe('the context charge route', () => {
  it('records a guideline charge with no run, under the canonical folder, and refuses another purpose', async () => {
    const env = await startService();
    const body = { purpose: 'guideline', project: env.layout.project, model: 'opus', inputTokens: 7, outputTokens: 3, totalTokens: 10 };
    const recorded = await env.http('POST', '/v1/context-charges', { body });
    expect(recorded.status).toBe(201);
    expectSchema('ContextChargeResponse', recorded.json);
    expect(env.store.contextCharges.list({})).toMatchObject([{ purpose: 'guideline', runId: null, model: 'opus', totalTokens: 10 }]);
    expect((await env.http('POST', '/v1/context-charges', { body: { ...body, purpose: 'reflection' } })).status).toBe(400);
  });

  it('records the billed detail of a guideline call: response id, cached input, cost and timing', async () => {
    const env = await startService();
    const detail = { responseId: 'resp_1', cachedInputTokens: 2, cost: { amount: 0.25, currency: 'USD', priceVersion: '2026-01-01' }, timing: { firstEventMs: 4, durationMs: 61_000 } };
    const body = { purpose: 'guideline', project: env.layout.project, model: 'opus', inputTokens: 7, outputTokens: 3, totalTokens: 10, detail };
    const recorded = await env.http('POST', '/v1/context-charges', { body });
    expect(recorded.status).toBe(201);
    expectSchema('ContextChargeResponse', recorded.json);
    expect(env.store.contextCharges.list({})).toMatchObject([{ purpose: 'guideline', detail }]);
    expect((await env.http('POST', '/v1/context-charges', { body: { ...body, detail: { timing: { durationMs: -1 } } } })).status).toBe(400);
  });

  it('answers a repeated charge for a response id with the stored one and refuses a different charge for it, so one call is never charged twice', async () => {
    const env = await startService();
    const body = { purpose: 'guideline', project: env.layout.project, model: 'opus', inputTokens: 7, outputTokens: 3, totalTokens: 10, detail: { responseId: 'resp_1' } };
    const first = await env.http('POST', '/v1/context-charges', { body });
    expect(first.status).toBe(201);

    const repeated = await env.http('POST', '/v1/context-charges', { body });
    expect(repeated.status).toBe(201);
    expect(repeated.json).toEqual(first.json);

    const different = await env.http('POST', '/v1/context-charges', { body: { ...body, inputTokens: 8, totalTokens: 11 } });

    expect(different.status).toBe(409);
    expect(JSON.stringify(different.json)).toContain('resp_1');
    expect(env.store.contextCharges.list({})).toHaveLength(1);
    expect((await env.http('POST', '/v1/context-charges', { body: { ...body, detail: { responseId: 'resp_2' } } })).status).toBe(201);
  });
});

describe('the model has no way to adopt a guideline', () => {
  it('covers the builtin, memory, history and governance tools of this repository: none is named or described after a guideline or a charge', () => {
    const unused = () => Promise.reject(new Error('unused'));
    const tools = [
      ...createBuiltinTools(),
      ...createMemoryTools({ port: { save: unused, search: async () => [] }, trusted: true }),
      ...createHistoryTools({
        port: { search: unused, read: () => null, projectOf: () => undefined, readDenial: unused, redact: (text) => text },
        trusted: true,
        project: '/p',
      }),
      ...createGovernanceTools({
        port: {
          propose: () => {
            throw new Error('unused');
          },
          find: () => undefined,
        },
        trusted: true,
      }),
    ];
    expect(tools.length).toBeGreaterThan(createBuiltinTools().length);
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/guideline|charge/i);
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/guideline|charge/i);
    }
  });

  it('keeps the adoption route behind the runtime socket, which the sandbox protects from the model', () => {
    const paths = momongaPaths('/home/user');
    const areas = protectedRootAreasOf(paths, '/home/user');
    expect(areas.some((area) => paths.sockets.runtime.startsWith(`${area}/`) || paths.sockets.runtime === area)).toBe(true);
  });
});
