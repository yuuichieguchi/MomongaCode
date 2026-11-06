import { describe, expect, it } from 'vitest';
import { buildContext, createTokenMeter } from '@momonga/context';
import type { CountTokensRequest, CountTokensResult, InputItem } from '@momonga/protocol';
import { MODEL, READ_TOOL, call, capabilitiesFor, fakeBlobs, fakeReader, inputFor, output, sourcesWith, user } from './helpers.ts';

type RecordingCounter = { calls: CountTokensRequest[]; count(request: CountTokensRequest): Promise<CountTokensResult> };

const renderingCounter = (): RecordingCounter => {
  const calls: CountTokensRequest[] = [];
  return {
    calls,
    count: async (request) => {
      calls.push(request);
      const lenient = request.momonga?.lenient_items;
      if (lenient === undefined) return { input_tokens: 1000, method: 'exact', error_bound: 0, error_shape: { ratio: 0, minimum: 0 } };
      const names = Object.values(lenient.call_names).join(',');
      return { input_tokens: (lenient.with_tools ? 10 : 20) + names.length, method: 'exact', error_bound: 0, error_shape: { ratio: 0, minimum: 0 } };
    },
  };
};

const OUTPUT: InputItem = { type: 'function_call_output', call_id: 'c1', output: 'x < y' };

const lenientCalls = (counter: RecordingCounter): CountTokensRequest[] =>
  counter.calls.filter((request) => request.momonga?.lenient_items !== undefined);

describe('TokenMeter.countItem renders a lone item in its real request shape', () => {
  it('sends the call names and the with-tools flag as momonga.lenient_items', async () => {
    const counter = renderingCounter();
    const meter = createTokenMeter({ counter, model: MODEL, capabilities: capabilitiesFor(200000) });
    expect(await meter.countItem(OUTPUT, { callNames: { c1: 'Read' }, withTools: true })).toBe(14);
    expect(counter.calls).toEqual([
      { model: MODEL, input: [OUTPUT], momonga: { lenient_items: { call_names: { c1: 'Read' }, with_tools: true } } },
    ]);
  });

  it('keeps the tool-message and the plain-history counts of one item apart, each cached', async () => {
    const counter = renderingCounter();
    const meter = createTokenMeter({ counter, model: MODEL, capabilities: capabilitiesFor(200000) });
    const withTools = await meter.countItem(OUTPUT, { callNames: { c1: 'Read' }, withTools: true });
    const withoutTools = await meter.countItem(OUTPUT, { callNames: { c1: 'Read' }, withTools: false });
    expect([withTools, withoutTools]).toEqual([14, 24]);
    expect(await meter.countItem(OUTPUT, { callNames: { c1: 'Read' }, withTools: true })).toBe(14);
    expect(await meter.countItem(OUTPUT, { callNames: { c1: 'Read' }, withTools: false })).toBe(24);
    expect(counter.calls).toHaveLength(2);
  });

  it('never shares a count between two call names of the same item', async () => {
    const counter = renderingCounter();
    const meter = createTokenMeter({ counter, model: MODEL, capabilities: capabilitiesFor(200000) });
    const read = await meter.countItem(OUTPUT, { callNames: { c1: 'Read' }, withTools: false });
    const grep = await meter.countItem(OUTPUT, { callNames: { c1: 'ReadOutput' }, withTools: false });
    expect([read, grep]).toEqual([24, 30]);
    expect(counter.calls).toHaveLength(2);
  });
});

describe('buildContext counts lone items with tools and the call name', () => {
  it('passes withTools true and the name of the matching call for every output it measures', async () => {
    const counter = renderingCounter();
    const capabilities = capabilitiesFor(200000);
    const meter = createTokenMeter({ counter, model: MODEL, capabilities });
    const history = [user(1, 'question'), call(2, 'c1'), output(3, 'c1', 'file body')];
    await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history, tools: [READ_TOOL], taskSeq: 0 }) }),
      { meter, blobs: fakeBlobs(), instructions: fakeReader({}) },
    );
    const lone = lenientCalls(counter);
    expect(lone.length).toBeGreaterThan(0);
    for (const request of lone) {
      expect(request.momonga?.lenient_items?.with_tools).toBe(true);
      expect(request.input).toHaveLength(1);
      const [item] = request.input as InputItem[];
      if (item?.type === 'function_call_output') {
        expect(request.momonga?.lenient_items?.call_names[item.call_id]).toBe('Peek');
      }
    }
    expect(lone.some((request) => (request.input as InputItem[])[0]?.type === 'function_call_output')).toBe(true);
  });
});
