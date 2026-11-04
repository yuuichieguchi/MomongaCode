import { describe, expect, it } from 'vitest';
import { buildContext, createTokenMeter } from '@momonga/context';
import { ESTIMATED_ERROR_SHAPE, marginFloorFor } from '@momonga/protocol';
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
  shapeCounter,
  sourcesWith,
  tokensOfItems,
  tokensOfTools,
  user,
} from './helpers.ts';

const message = (id: string, text: string): InputItem => ({ type: 'message', id, role: 'user', content: text });

const prefix: InputItem[] = [message('p1', 'alpha '.repeat(30)), message('p2', 'beta '.repeat(30))];
const suffix: InputItem[] = [message('s1', 'gamma '.repeat(10)), message('s2', 'delta')];

const SMALL_WINDOW = 1000;

const estimatedMeter = (window = 200000) =>
  createTokenMeter({
    counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE),
    model: MODEL,
    capabilities: capabilitiesFor(window, { tokenCounting: 'estimated' }),
  });

const exactMeterOf = (window = 200000) => createTokenMeter({ counter: fakeCounter(), model: MODEL, capabilities: capabilitiesFor(window) });

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

  it('extends an observed count: the kept report is the known part and only the new items are uncounted', async () => {
    const meter = estimatedMeter();
    const first = await meter.count({ input: prefix, tools: [] });
    const observed = first.inputTokens + 5;
    meter.observe({ inputDigest: first.inputDigest, inputTokens: observed });
    const appended = await meter.count({ input: [...prefix, ...suffix], tools: [] });
    expect(appended.inputTokens).toBe(observed + tokensOfItems(suffix));
    expect(appended.known).toBe(observed);
    expect(appended.uncounted).toBe(tokensOfItems(suffix));
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
    const counted = await exactMeterOf().count({ input: prefix, tools: [] });
    expect(counted.overTolerance).toBe(0);
    expect(counted.underAt(counted.inputTokens)).toBe(0);
    expect(counted.freshUnderAt(counted.inputTokens)).toBe(0);
  });

  it('adds no relative floor to an estimated counter whose reply shape is zero', async () => {
    const meter = createTokenMeter({
      counter: fakeCounter(0, 'estimated'),
      model: MODEL,
      capabilities: capabilitiesFor(200000, { tokenCounting: 'estimated' }),
    });
    const counted = await meter.count({ input: prefix, tools: [] });
    expect(counted.underAt(counted.inputTokens)).toBe(0);
    expect(counted.overTolerance).toBe(0);
  });

  it('adds the counter error_bound', async () => {
    const meter = createTokenMeter({ counter: fakeCounter(13), model: MODEL, capabilities: capabilitiesFor(200000) });
    const counted = await meter.count({ input: prefix, tools: [] });
    expect(counted.overTolerance).toBe(13);
    expect(counted.underAt(counted.inputTokens)).toBe(13);
    expect(counted.freshUnderAt(counted.inputTokens)).toBe(13);
  });

  it('keeps the observed excess of the last 20 reports and drops it with the 21st', async () => {
    const floor = marginFloorFor(SMALL_WINDOW);
    const meter = exactMeterOf(SMALL_WINDOW);
    const first = await meter.count({ input: prefix, tools: [] });
    const reported = Math.round(first.inputTokens * 1.5);
    meter.observe({ inputDigest: first.inputDigest, inputTokens: reported });
    const miss = reported - first.inputTokens;
    const other = await meter.count({ input: suffix, tools: [] });
    const scaled = (size: number): number => Math.ceil(miss * Math.max(1, size / first.inputTokens)) - floor;
    expect(other.freshUnderAt(other.inputTokens)).toBe(scaled(other.inputTokens));
    expect(scaled(other.inputTokens)).toBeGreaterThan(0);
    for (let index = 0; index < 19; index += 1) {
      const counted = await meter.count({ input: [message(`m${index}`, `exact ${index}`)], tools: [] });
      meter.observe({ inputDigest: counted.inputDigest, inputTokens: counted.inputTokens });
    }
    expect((await meter.count({ input: suffix, tools: [] })).freshUnderAt(other.inputTokens)).toBe(scaled(other.inputTokens));
    const last = await meter.count({ input: [message('m-last', 'exact last')], tools: [] });
    meter.observe({ inputDigest: last.inputDigest, inputTokens: last.inputTokens });
    expect((await meter.count({ input: suffix, tools: [] })).freshUnderAt(other.inputTokens)).toBe(0);
  });

  it('widens the estimated bound with a high report and does not lower it with a later low one', async () => {
    const floor = marginFloorFor(SMALL_WINDOW);
    const meter = estimatedMeter(SMALL_WINDOW);
    const exact = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: exact.inputDigest, inputTokens: exact.inputTokens });
    const probe = await meter.count({ input: [message('hi', 'h'.repeat(400))], tools: [] });
    const shapeOnly = probe.freshUnderAt(probe.inputTokens);
    expect(shapeOnly).toBe(Math.ceil(0.3 * probe.inputTokens));
    meter.observe({ inputDigest: probe.inputDigest, inputTokens: probe.inputTokens * 3 });
    const widened = (await meter.count({ input: [message('hj', 'h'.repeat(400))], tools: [] })).freshUnderAt(probe.inputTokens);
    expect(widened).toBe(shapeOnly + Math.max(0, probe.inputTokens * 2 - Math.ceil(0.3 * probe.inputTokens) - floor));
    const low = await meter.count({ input: [message('lo', 'l'.repeat(400))], tools: [] });
    meter.observe({ inputDigest: low.inputDigest, inputTokens: 10 });
    expect((await meter.count({ input: [message('hj', 'h'.repeat(400))], tools: [] })).freshUnderAt(probe.inputTokens)).toBe(widened);
  });
});

describe('TokenMeter inside buildContext', () => {
  const estimatedHarness = (capabilities: ReturnType<typeof capabilitiesFor>) =>
    harness(capabilities, { counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE) });

  it('reuses the observed usage of the previous build on an append-only step', async () => {
    const capabilities = capabilitiesFor(200000, { tokenCounting: 'estimated' });
    const { ports, meter } = estimatedHarness(capabilities);
    const history = [user(1, 'q1'), assistant(2, 'a1')];
    const first = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    expect(first.inputTokens).toBe(tokensOfItems(first.input));
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens + 5 });
    const second = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history: [...history, user(3, 'q2')] }) }),
      ports,
    );
    expect(second.inputTokens).toBe(first.inputTokens + 5 + tokensOfItems(second.input.slice(first.input.length)));
  });

  it('widens the margin by the observed excess of the report beyond the margin floor', async () => {
    const capabilities = capabilitiesFor(2000, { maxOutputTokens: 256 });
    const floor = marginFloorFor(2000);
    const prompt = (word: string): string => `${word} `.repeat(120);
    const { ports, meter } = harness(capabilities);
    const first = await buildContext(inputFor(capabilities, { sources: sourcesWith({ systemPrompt: prompt('base') }) }), ports);
    expect(first.inputTokens).toBeGreaterThan(floor);
    expect(first.budget.margin).toBe(floor);
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens * 2 });
    const unrelated = await buildContext(inputFor(capabilities, { sources: sourcesWith({ systemPrompt: prompt('other') }) }), harness(capabilities).ports);
    expect(unrelated.budget.margin).toBe(floor);
    const second = await buildContext(inputFor(capabilities, { sources: sourcesWith({ systemPrompt: prompt('next') }) }), ports);
    const scaled = Math.ceil(first.inputTokens * Math.max(1, second.inputTokens / first.inputTokens));
    expect(second.budget.margin).toBe(floor + Math.max(0, scaled - floor));
    expect(second.budget.margin).toBeGreaterThan(floor);
    expect(second.budget.I).toBe(2000 - 256 - second.budget.margin);
  });
});

describe('TokenMeter directional error correction', () => {
  const exactMeter = () => exactMeterOf(SMALL_WINDOW);

  it('records no excess when usage reports far fewer tokens than the estimate', async () => {
    const meter = exactMeter();
    const first = await meter.count({ input: prefix, tools: [] });
    const observed = meter.observe({ inputDigest: first.inputDigest, inputTokens: 10 });
    expect(observed.miss).toBe(0);
    expect(observed.kept).toBe(first.inputTokens);
    const recounted = await meter.count({ input: prefix, tools: [] });
    expect(recounted.inputTokens).toBe(first.inputTokens);
    expect(recounted.underAt(recounted.inputTokens)).toBe(0);
  });

  it('adds no floor to the estimated bound after a low usage report', async () => {
    const meter = createTokenMeter({
      counter: fakeCounter(0, 'estimated'),
      model: MODEL,
      capabilities: capabilitiesFor(200000, { tokenCounting: 'estimated' }),
    });
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: 10 });
    const recounted = await meter.count({ input: prefix, tools: [] });
    expect(recounted.inputTokens).toBe(first.inputTokens);
    expect(recounted.underAt(recounted.inputTokens)).toBe(0);
  });

  it('gives an observed digest the same count and bounds after the count caches have turned over', async () => {
    const meter = createTokenMeter({ counter: fakeCounter(13), model: MODEL, capabilities: capabilitiesFor(200000) });
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens * 2 });
    const cached = await meter.count({ input: prefix, tools: [] });
    for (let index = 0; index < 1100; index += 1) {
      await meter.count({ input: [message(`filler${index}`, `f${index}`)], tools: [] });
    }
    const reread = await meter.count({ input: prefix, tools: [] });
    expect(reread.inputTokens).toBe(cached.inputTokens);
    expect(reread.known).toBe(cached.known);
    expect(reread.underAt(reread.inputTokens)).toBe(cached.underAt(cached.inputTokens));
    expect(reread.freshUnderAt(reread.inputTokens)).toBe(cached.freshUnderAt(cached.inputTokens));
  });

  it('keeps an earlier under-estimate when a later report is low', async () => {
    const meter = exactMeter();
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens * 2 });
    const before = (await meter.count({ input: [message('z', 'z'.repeat(40))], tools: [] })).freshUnderAt(first.inputTokens);
    expect(before).toBeGreaterThan(0);
    const other = await meter.count({ input: suffix, tools: [] });
    meter.observe({ inputDigest: other.inputDigest, inputTokens: 1 });
    expect((await meter.count({ input: [message('y', 'y'.repeat(40))], tools: [] })).freshUnderAt(first.inputTokens)).toBe(before);
  });

  it('measures the miss against the count and keeps the higher observed count as the known part', async () => {
    const meter = exactMeter();
    const first = await meter.count({ input: prefix, tools: [] });
    const observed = meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens * 2 });
    expect(observed.miss).toBe(first.inputTokens);
    expect(observed.kept).toBe(first.inputTokens * 2);
    const appended = await meter.count({ input: [...prefix, ...suffix], tools: [] });
    expect(appended.known).toBe(0);
    expect(appended.inputTokens).toBe(first.inputTokens + tokensOfItems(suffix));
  });

  it('does not cap the miss at the size of the input', async () => {
    const floor = marginFloorFor(SMALL_WINDOW);
    const meter = exactMeter();
    const first = await meter.count({ input: prefix, tools: [] });
    const observed = meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens * 100 });
    expect(observed.miss).toBe(first.inputTokens * 99);
    const other = await meter.count({ input: suffix, tools: [] });
    expect(other.freshUnderAt(first.inputTokens)).toBe(first.inputTokens * 99 - floor);
  });

  it('extends a low-observed digest from the estimate, not from the low report', async () => {
    const meter = exactMeter();
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: 10 });
    const appended = await meter.count({ input: [...prefix, ...suffix], tools: [] });
    expect(appended.inputTokens).toBe(first.inputTokens + tokensOfItems(suffix));
  });

  it('takes the fresh count for a high-observed digest while the new items are smaller than the miss, because its bound on the server count is smaller', async () => {
    const floor = marginFloorFor(SMALL_WINDOW);
    const meter = exactMeter();
    const first = await meter.count({ input: prefix, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens * 2 });
    const added = tokensOfItems(suffix);
    expect(added).toBeLessThan(first.inputTokens);
    const appended = await meter.count({ input: [...prefix, ...suffix], tools: [] });
    expect(appended.known).toBe(0);
    expect(appended.inputTokens).toBe(first.inputTokens + added);
    expect(appended.underAt(appended.inputTokens)).toBe(first.inputTokens + added - floor);
    const splitScore = first.inputTokens * 2 + added + (first.inputTokens - floor);
    expect(appended.inputTokens + appended.underAt(appended.inputTokens)).toBeLessThan(splitScore);
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
  const countingMeter = (counterBound: number) =>
    createTokenMeter({
      counter: fakeCounter(counterBound, 'estimated'),
      model: MODEL,
      capabilities: capabilitiesFor(200000, { tokenCounting: 'estimated' }),
    });

  it('takes the minimum of the reply shape, with no relative floor above it', async () => {
    const counted = await countingMeter(1).count({ input: prefix, tools: [] });
    expect(Math.ceil(0.1 * counted.inputTokens)).toBeGreaterThan(1);
    expect(counted.underAt(counted.inputTokens)).toBe(1);
  });

  it('takes the reply shape of the gateway bound', async () => {
    const counted = await countingMeter(500).count({ input: prefix, tools: [] });
    expect(counted.underAt(counted.inputTokens)).toBe(500);
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
    expect(second.budget.margin).toBe(budgetFor(8192, 1024).margin);
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
    const meter = estimatedMeter();
    const first = await meter.count({ input: prefix, tools: [READ_TOOL] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens + 5 });
    const appended = await meter.count({ input: [...prefix, ...suffix], tools: [READ_TOOL] });
    expect(appended.inputTokens).toBe(first.inputTokens + 5 + tokensOfItems(suffix));
  });
});
