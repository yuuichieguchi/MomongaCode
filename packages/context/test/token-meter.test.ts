import { describe, expect, it } from 'vitest';
import { buildContext, createTokenMeter } from '@momonga/context';
import type { InputItem } from '@momonga/protocol';
import {
  MODEL,
  READ_TOOL,
  assistant,
  budgetFor,
  call,
  capabilitiesFor,
  fakeCounter,
  harness,
  inputFor,
  output,
  sourcesWith,
  tokensOfItems,
  tokensOfTools,
  user,
} from './helpers.ts';

const message = (id: string, text: string): InputItem => ({ type: 'message', id, role: 'user', content: text });

const prefix: InputItem[] = [message('p1', 'alpha '.repeat(30)), message('p2', 'beta '.repeat(30))];
const suffix: InputItem[] = [message('s1', 'gamma '.repeat(10)), message('s2', 'delta')];

const countedItems = (calls: ReturnType<typeof fakeCounter>['calls']): InputItem[] =>
  calls.flatMap((request) => (typeof request.input === 'string' ? [] : request.input));

describe('TokenMeter counting', () => {
  it('counts a fresh input through the counter', async () => {
    const counter = fakeCounter();
    const meter = createTokenMeter({ counter, model: MODEL, capabilities: capabilitiesFor(200000) });
    const counted = await meter.count({ input: prefix, tools: [] });
    expect(counted.inputTokens).toBe(tokensOfItems(prefix));
    expect(counted.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(counter.calls.length).toBeGreaterThan(0);
    expect(counter.calls.every((request) => request.model === MODEL)).toBe(true);
  });

  it('reuses an observed count for an append-only input and counts only the suffix', async () => {
    const counter = fakeCounter();
    const meter = createTokenMeter({ counter, model: MODEL, capabilities: capabilitiesFor(200000) });
    const first = await meter.count({ input: prefix, tools: [] });
    const observed = first.inputTokens + 50;
    meter.observe({ inputDigest: first.inputDigest, inputTokens: observed });
    counter.calls.length = 0;
    const appended = await meter.count({ input: [...prefix, ...suffix], tools: [] });
    expect(appended.inputTokens).toBe(observed + tokensOfItems(suffix));
    const recounted = countedItems(counter.calls);
    expect(recounted.some((item) => item.id === 'p1' || item.id === 'p2')).toBe(false);
  });

  it('gives the same digest for identical inputs and a different one when tools change', async () => {
    const meter = createTokenMeter({ counter: fakeCounter(), model: MODEL, capabilities: capabilitiesFor(200000) });
    const a = await meter.count({ input: prefix, tools: [] });
    const b = await meter.count({ input: prefix, tools: [] });
    const c = await meter.count({ input: prefix, tools: [READ_TOOL] });
    const d = await meter.count({ input: prefix, tools: [], instructions: 'extra' });
    expect(b.inputDigest).toBe(a.inputDigest);
    expect(c.inputDigest).not.toBe(a.inputDigest);
    expect(d.inputDigest).not.toBe(a.inputDigest);
  });

  it('misses the observation when an earlier item changes, as after eviction', async () => {
    const meter = createTokenMeter({ counter: fakeCounter(), model: MODEL, capabilities: capabilitiesFor(200000) });
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens + 50 });
    const evicted: InputItem[] = [message('p1', '[tool output omitted]'), prefix[1] as InputItem, ...suffix];
    const counted = await meter.count({ input: evicted, tools: [] });
    expect(counted.inputTokens).toBe(tokensOfItems(evicted));
  });

  it('misses the observation when the prefix is replaced by a compaction', async () => {
    const meter = createTokenMeter({ counter: fakeCounter(), model: MODEL, capabilities: capabilitiesFor(200000) });
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens + 50 });
    const compacted: InputItem[] = [{ type: 'compaction', encrypted_content: 'enc' }, ...suffix];
    const counted = await meter.count({ input: compacted, tools: [] });
    expect(counted.inputTokens).toBe(tokensOfItems(compacted));
  });

  it('misses the observation when the instructions or tools change', async () => {
    const meter = createTokenMeter({ counter: fakeCounter(), model: MODEL, capabilities: capabilitiesFor(200000) });
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens + 50 });
    const counted = await meter.count({ input: [...prefix, ...suffix], tools: [READ_TOOL] });
    expect(counted.inputTokens).not.toBe(first.inputTokens + 50 + tokensOfItems(suffix));
  });
});

describe('TokenMeter error bound', () => {
  it('starts at zero for exact counting without observations', async () => {
    const meter = createTokenMeter({ counter: fakeCounter(), model: MODEL, capabilities: capabilitiesFor(200000) });
    expect(meter.relativeError()).toBe(0);
    const counted = await meter.count({ input: prefix, tools: [] });
    expect(counted.errorBound).toBe(0);
  });

  it('uses at least 10% in estimated mode until observations exist', async () => {
    const meter = createTokenMeter({
      counter: fakeCounter(0, 'estimated'),
      model: MODEL,
      capabilities: capabilitiesFor(200000, { tokenCounting: 'estimated' }),
    });
    expect(meter.relativeError()).toBe(0.1);
    const counted = await meter.count({ input: prefix, tools: [] });
    expect(counted.errorBound).toBe(Math.ceil(0.1 * counted.inputTokens));
  });

  it('adds the counter error_bound', async () => {
    const meter = createTokenMeter({ counter: fakeCounter(13), model: MODEL, capabilities: capabilitiesFor(200000) });
    const counted = await meter.count({ input: prefix, tools: [] });
    expect(counted.errorBound).toBe(13);
  });

  it('tracks the maximum relative error against observed usage over the last 20 observations', async () => {
    const meter = createTokenMeter({ counter: fakeCounter(), model: MODEL, capabilities: capabilitiesFor(200000) });
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: Math.round(first.inputTokens * 1.5) });
    const expectedError = (Math.round(first.inputTokens * 1.5) - first.inputTokens) / first.inputTokens;
    expect(meter.relativeError()).toBeCloseTo(expectedError, 10);
    const other = await meter.count({ input: suffix, tools: [] });
    expect(other.errorBound).toBe(Math.ceil(expectedError * other.inputTokens));
    for (let index = 0; index < 19; index += 1) {
      const counted = await meter.count({ input: [message(`m${index}`, `exact ${index}`)], tools: [] });
      meter.observe({ inputDigest: counted.inputDigest, inputTokens: counted.inputTokens });
    }
    expect(meter.relativeError()).toBeCloseTo(expectedError, 10);
    const last = await meter.count({ input: [message('m-last', 'exact last')], tools: [] });
    meter.observe({ inputDigest: last.inputDigest, inputTokens: last.inputTokens });
    expect(meter.relativeError()).toBe(0);
  });

  it('widens but never lowers the estimated-mode floor with observations', async () => {
    const meter = createTokenMeter({
      counter: fakeCounter(0, 'estimated'),
      model: MODEL,
      capabilities: capabilitiesFor(200000, { tokenCounting: 'estimated' }),
    });
    const exact = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: exact.inputDigest, inputTokens: exact.inputTokens });
    expect(meter.relativeError()).toBe(0.1);
    const high = await meter.count({ input: [message('hi', 'h'.repeat(400))], tools: [] });
    meter.observe({ inputDigest: high.inputDigest, inputTokens: high.inputTokens * 1.5 });
    expect(meter.relativeError()).toBe(0.5);
  });
});

describe('TokenMeter inside buildContext', () => {
  it('reuses the observed usage of the previous build on an append-only step', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports, meter } = harness(capabilities);
    const history = [user(1, 'q1'), assistant(2, 'a1')];
    const first = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    expect(first.inputTokens).toBe(tokensOfItems(first.input));
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens + 40 });
    const second = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history: [...history, user(3, 'q2')] }) }),
      ports,
    );
    expect(second.inputTokens).toBe(first.inputTokens + 40 + tokensOfItems(second.input.slice(first.input.length)));
  });

  it('widens the margin by the observed error bound', async () => {
    const capabilities = capabilitiesFor(200000, { maxOutputTokens: 8192 });
    const { ports, meter } = harness(capabilities);
    const first = await buildContext(inputFor(capabilities), ports);
    expect(first.budget.margin).toBe(4000);
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens * 2 });
    const unrelated = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ systemPrompt: 'different prompt' }) }),
      harness(capabilities).ports,
    );
    expect(unrelated.budget.margin).toBe(4000);
    const second = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ systemPrompt: 'another prompt' }) }),
      ports,
    );
    expect(second.budget.margin).toBe(4000 + Math.ceil(1.0 * second.inputTokens));
    expect(second.budget.I).toBe(200000 - 8192 - second.budget.margin);
  });
});

describe('TokenMeter directional error correction', () => {
  const exactMeter = () => createTokenMeter({ counter: fakeCounter(), model: MODEL, capabilities: capabilitiesFor(200000) });

  it('records no error when usage reports far fewer tokens than the estimate', async () => {
    const meter = exactMeter();
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: 10 });
    expect(meter.relativeError()).toBe(0);
    const recounted = await meter.count({ input: prefix, tools: [] });
    expect(recounted.inputTokens).toBe(first.inputTokens);
    expect(recounted.errorBound).toBe(0);
  });

  it('keeps the estimated-mode floor after a low usage report', async () => {
    const meter = createTokenMeter({
      counter: fakeCounter(0, 'estimated'),
      model: MODEL,
      capabilities: capabilitiesFor(200000, { tokenCounting: 'estimated' }),
    });
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: 10 });
    expect(meter.relativeError()).toBe(0.1);
    const recounted = await meter.count({ input: prefix, tools: [] });
    expect(recounted.inputTokens).toBe(first.inputTokens);
    expect(recounted.errorBound).toBe(Math.ceil(0.1 * first.inputTokens));
  });

  it('gives an observed digest the same bound after it leaves the counted cache', async () => {
    const meter = createTokenMeter({ counter: fakeCounter(13), model: MODEL, capabilities: capabilitiesFor(200000) });
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens * 2 });
    const cached = await meter.count({ input: prefix, tools: [] });
    expect(cached.errorBound).toBe(first.inputTokens * 2 + 13);
    for (let index = 0; index < 1100; index += 1) {
      await meter.count({ input: [message(`filler${index}`, `f${index}`)], tools: [] });
    }
    const reread = await meter.count({ input: prefix, tools: [] });
    expect(reread.inputTokens).toBe(first.inputTokens * 2);
    expect(reread.errorBound).toBe(cached.errorBound);
  });

  it('keeps an earlier under-estimate when a later report is low', async () => {
    const meter = exactMeter();
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens * 2 });
    const other = await meter.count({ input: suffix, tools: [] });
    meter.observe({ inputDigest: other.inputDigest, inputTokens: 1 });
    expect(meter.relativeError()).toBe(1);
  });

  it('measures the error relative to the estimate and adopts the higher observed count', async () => {
    const meter = exactMeter();
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens * 2 });
    expect(meter.relativeError()).toBe(1);
    const recounted = await meter.count({ input: prefix, tools: [] });
    expect(recounted.inputTokens).toBe(first.inputTokens * 2);
    expect(recounted.errorBound).toBe(first.inputTokens * 2);
  });

  it('caps the relative error at 1.0', async () => {
    const meter = exactMeter();
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens * 100 });
    expect(meter.relativeError()).toBe(1);
    const recounted = await meter.count({ input: prefix, tools: [] });
    expect(recounted.inputTokens).toBe(first.inputTokens * 100);
    const other = await meter.count({ input: suffix, tools: [] });
    expect(other.errorBound).toBe(other.inputTokens);
  });

  it('extends a low-observed digest from the estimate, not from the low report', async () => {
    const meter = exactMeter();
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: 10 });
    const appended = await meter.count({ input: [...prefix, ...suffix], tools: [] });
    expect(appended.inputTokens).toBe(first.inputTokens + tokensOfItems(suffix));
  });

  it('extends a high-observed digest from the observed count', async () => {
    const meter = exactMeter();
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens * 2 });
    const appended = await meter.count({ input: [...prefix, ...suffix], tools: [] });
    expect(appended.inputTokens).toBe(first.inputTokens * 2 + tokensOfItems(suffix));
  });

  it('extends a low-observed digest with tools without double-counting the baseline', async () => {
    const meter = exactMeter();
    const first = await meter.count({ input: prefix, tools: [READ_TOOL] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: 10 });
    const appended = await meter.count({ input: [...prefix, ...suffix], tools: [READ_TOOL] });
    expect(appended.inputTokens).toBe(first.inputTokens + tokensOfItems(suffix));
  });
});

describe('TokenMeter estimated-mode bound', () => {
  const estimatedMeter = (counterBound: number) =>
    createTokenMeter({
      counter: fakeCounter(counterBound, 'estimated'),
      model: MODEL,
      capabilities: capabilitiesFor(200000, { tokenCounting: 'estimated' }),
    });

  it('uses the relative floor when it exceeds the gateway bound', async () => {
    const counted = await estimatedMeter(1).count({ input: prefix, tools: [] });
    expect(Math.ceil(0.1 * counted.inputTokens)).toBeGreaterThan(1);
    expect(counted.errorBound).toBe(Math.ceil(0.1 * counted.inputTokens));
  });

  it('uses the gateway bound when it exceeds the relative floor', async () => {
    const counted = await estimatedMeter(500).count({ input: prefix, tools: [] });
    expect(Math.ceil(0.1 * counted.inputTokens)).toBeLessThan(500);
    expect(counted.errorBound).toBe(500);
  });
});

describe('TokenMeter low usage inside buildContext', () => {
  it('keeps the input budget after a low usage report on a small window', async () => {
    const capabilities = capabilitiesFor(8192, { maxOutputTokens: 1024 });
    const { ports, meter } = harness(capabilities);
    const systemPrompt = 'pinned context line. '.repeat(370);
    const first = await buildContext(inputFor(capabilities, { sources: sourcesWith({ systemPrompt }) }), ports);
    expect(first.inputTokens).toBeGreaterThan(1900);
    expect(first.inputTokens).toBeLessThan(2100);
    meter.observe({ inputDigest: first.inputDigest, inputTokens: 10 });
    const second = await buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({ systemPrompt, history: [call(1, 'call_1'), output(2, 'call_1', 'file contents')] }),
      }),
      ports,
    );
    expect(second.budget.I).toBeGreaterThan(first.inputTokens);
    expect(second.budget.margin).toBe(budgetFor(8192, 1024).margin + Math.ceil(meter.relativeError() * second.inputTokens));
    expect(second.inputTokens).toBe(first.inputTokens + tokensOfItems(second.input.slice(first.input.length)));
  });
});

describe('TokenMeter forwards tools', () => {
  it('passes the request tools on every counter call, including suffix counts', async () => {
    const counter = fakeCounter();
    const meter = createTokenMeter({ counter, model: MODEL, capabilities: capabilitiesFor(200000) });
    const first = await meter.count({ input: prefix, tools: [READ_TOOL] });
    expect(counter.calls.length).toBeGreaterThan(0);
    expect(counter.calls.every((request) => JSON.stringify(request.tools) === JSON.stringify([READ_TOOL]))).toBe(true);
    expect(first.inputTokens).toBe(tokensOfItems(prefix) + tokensOfTools([READ_TOOL]));
  });

  it('does not double-count tools when reusing an observation', async () => {
    const meter = createTokenMeter({ counter: fakeCounter(), model: MODEL, capabilities: capabilitiesFor(200000) });
    const first = await meter.count({ input: prefix, tools: [READ_TOOL] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens + 50 });
    const appended = await meter.count({ input: [...prefix, ...suffix], tools: [READ_TOOL] });
    expect(appended.inputTokens).toBe(first.inputTokens + 50 + tokensOfItems(suffix));
  });
});
