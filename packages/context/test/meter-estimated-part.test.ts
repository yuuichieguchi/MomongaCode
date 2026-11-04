import { describe, expect, it } from 'vitest';
import { createTokenMeter } from '@momonga/context';
import { ESTIMATED_ERROR_SHAPE, countReplyOf } from '@momonga/protocol';
import type { ErrorShape } from '@momonga/protocol';
import type { CountTokensRequest, CountTokensResult, FunctionTool, InputItem } from '@momonga/protocol';
import { MODEL, capabilitiesFor } from './helpers.ts';

const NO_ERROR: ErrorShape = { ratio: 0, minimum: 0 };

const countingAs = (method: CountTokensResult['method']) => ({
  count: async (request: CountTokensRequest): Promise<CountTokensResult> =>
    countReplyOf((Array.isArray(request.input) ? request.input.length : 1) * 100, method, method === 'estimated' ? ESTIMATED_ERROR_SHAPE : NO_ERROR),
});

const items = (count: number): InputItem[] =>
  Array.from({ length: count }, (_, index): InputItem => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `message ${index}` }] }));

const WINDOW = 200000;

describe('the part of a count that is uncounted by the server', () => {
  it('is the whole count for a fresh input, with the shape of the counter on the whole', async () => {
    const meter = createTokenMeter({ counter: countingAs('estimated'), model: MODEL, capabilities: capabilitiesFor(WINDOW, { tokenCounting: 'estimated' }) });
    const counted = await meter.count({ input: items(3), tools: [] });
    expect(counted.uncounted).toBe(300);
    expect(counted.known).toBe(0);
    expect(counted.underAt(300)).toBe(90);
  });

  it.each(['exact', 'calibrated'] as const)('is bounded by the %s shape of the counter, which has no ratio here', async (method) => {
    const meter = createTokenMeter({ counter: countingAs(method), model: MODEL, capabilities: capabilitiesFor(WINDOW, { tokenCounting: method }) });
    const counted = await meter.count({ input: items(3), tools: [] });
    expect(counted.uncounted).toBe(300);
    expect(counted.underAt(300)).toBe(0);
  });

  it('is only the new items when the server reported the prefix at or above the estimate', async () => {
    const meter = createTokenMeter({ counter: countingAs('estimated'), model: MODEL, capabilities: capabilitiesFor(WINDOW, { tokenCounting: 'estimated' }) });
    const prefix = await meter.count({ input: items(2), tools: [] });
    meter.observe({ inputDigest: prefix.inputDigest, inputTokens: 200 });
    const longer = await meter.count({ input: items(3), tools: [] });
    expect(longer.uncounted).toBe(100);
    expect(longer.known).toBe(200);
    expect(longer.underAt(300)).toBe(30);
  });

  it('leaves out the tools the server already confirmed when only the suffix is counted with them', async () => {
    const tools = [{ type: 'function', name: 'Read', description: 'reads', parameters: { type: 'object' } }] as unknown as FunctionTool[];
    const counter = {
      count: async (request: CountTokensRequest): Promise<CountTokensResult> =>
        countReplyOf((Array.isArray(request.input) ? request.input.length : 1) * 100 + (request.tools === undefined ? 0 : 5000), 'estimated', NO_ERROR),
    };
    const meter = createTokenMeter({ counter, model: MODEL, capabilities: capabilitiesFor(WINDOW, { tokenCounting: 'estimated' }) });
    const prefix = await meter.count({ input: items(2), tools });
    expect(prefix.uncounted).toBe(5200);
    meter.observe({ inputDigest: prefix.inputDigest, inputTokens: 5200 });

    const longer = await meter.count({ input: items(3), tools });

    expect(longer.inputTokens).toBe(5300);
    expect(longer.known).toBe(5200);
    expect(longer.uncounted).toBe(100);
  });

  it('keeps the report as the known part when the server reported it below the estimate, because the estimate is what the meter still holds', async () => {
    const meter = createTokenMeter({ counter: countingAs('estimated'), model: MODEL, capabilities: capabilitiesFor(WINDOW, { tokenCounting: 'estimated' }) });
    const prefix = await meter.count({ input: items(2), tools: [] });
    meter.observe({ inputDigest: prefix.inputDigest, inputTokens: 170 });
    expect((await meter.count({ input: items(2), tools: [] })).inputTokens).toBe(200);
    const longer = await meter.count({ input: items(3), tools: [] });
    expect(longer.inputTokens).toBe(300);
    expect(longer.known).toBe(200);
    expect(longer.uncounted).toBe(100);
    expect(longer.overTolerance).toBe(30 + 30);
  });
});
