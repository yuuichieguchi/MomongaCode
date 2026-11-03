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

describe('the part of a count that is estimated', () => {
  it('is the whole count when the counter estimated it', async () => {
    const meter = createTokenMeter({ counter: countingAs('estimated'), model: MODEL, capabilities: capabilitiesFor(200000) });
    const counted = await meter.count({ input: items(3), tools: [] });
    expect(counted.estimatedTokens).toBe(300);
  });

  it.each(['exact', 'calibrated'] as const)('is nothing when the counter was %s', async (method) => {
    const meter = createTokenMeter({ counter: countingAs(method), model: MODEL, capabilities: capabilitiesFor(200000) });
    expect((await meter.count({ input: items(3), tools: [] })).estimatedTokens).toBe(0);
  });

  it('is only the suffix when the server reported the prefix at or above the estimate', async () => {
    const meter = createTokenMeter({ counter: countingAs('estimated'), model: MODEL, capabilities: capabilitiesFor(200000) });
    const prefix = await meter.count({ input: items(2), tools: [] });
    meter.observe({ inputDigest: prefix.inputDigest, inputTokens: 200 });
    const longer = await meter.count({ input: items(3), tools: [] });
    expect(longer.estimatedTokens).toBe(100);
  });

  it('leaves out the tools the server already confirmed when only the suffix is counted with them', async () => {
    const tools = [{ type: 'function', name: 'Read', description: 'reads', parameters: { type: 'object' } }] as unknown as FunctionTool[];
    const counter = {
      count: async (request: CountTokensRequest): Promise<CountTokensResult> =>
        countReplyOf((Array.isArray(request.input) ? request.input.length : 1) * 100 + (request.tools === undefined ? 0 : 5000), 'estimated', NO_ERROR),
    };
    const meter = createTokenMeter({ counter, model: MODEL, capabilities: capabilitiesFor(200000) });
    const prefix = await meter.count({ input: items(2), tools });
    expect(prefix.estimatedTokens).toBe(5200);
    meter.observe({ inputDigest: prefix.inputDigest, inputTokens: 5200 });

    const longer = await meter.count({ input: items(3), tools });

    expect(longer.inputTokens).toBe(5300);
    expect(longer.estimatedTokens).toBe(100);
  });

  it('keeps the prefix when the server reported it below the estimate, because the estimate is what the meter still holds', async () => {
    const meter = createTokenMeter({ counter: countingAs('estimated'), model: MODEL, capabilities: capabilitiesFor(200000) });
    const prefix = await meter.count({ input: items(2), tools: [] });
    meter.observe({ inputDigest: prefix.inputDigest, inputTokens: 170 });
    expect((await meter.count({ input: items(2), tools: [] })).estimatedTokens).toBe(200);
    const longer = await meter.count({ input: items(3), tools: [] });
    expect(longer.estimatedTokens).toBe(300);
  });
});
