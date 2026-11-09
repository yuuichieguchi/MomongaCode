import { describe, expect, it, vi } from 'vitest';
import { createTokenMeter, maxInputFor } from '@momonga/context';
import type { MeterCount, TokenMeter } from '@momonga/context';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import type { InputItem } from '@momonga/protocol';
import { MODEL, capabilitiesFor, fakeCounter, seeded, shapeCounter } from './helpers.ts';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const message = (letter: string, size: number): InputItem => ({ type: 'message', role: 'user', content: letter.repeat(size) });

const estimatedMeter = (): TokenMeter =>
  createTokenMeter({ counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE), model: MODEL, capabilities: capabilitiesFor(200000, { tokenCounting: 'estimated' }) });

describe('one bound rule: a function of the uncounted part only', () => {
  it('gives an observed exact count no bound from the counter', async () => {
    const meter = estimatedMeter();
    const fresh = await meter.count({ input: [message('a', 4000)], tools: [] });
    meter.observe({ inputDigest: fresh.inputDigest, inputTokens: fresh.inputTokens });
    const observed = await meter.count({ input: [message('a', 4000)], tools: [] });
    expect(observed.underAt(0)).toBe(0);
    expect(observed.underAt(observed.inputTokens)).toBe(0);
    expect(observed.overTolerance).toBe(0);
  });

  it('adds nothing from the counter for an observed count under an exact-mode meter', async () => {
    const meter = createTokenMeter({
      counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE),
      model: MODEL,
      capabilities: capabilitiesFor(200000, { tokenCounting: 'exact' }),
    });
    const fresh = await meter.count({ input: [message('a', 4000)], tools: [] });
    expect(fresh.underAt(fresh.inputTokens)).toBeGreaterThan(0);
    meter.observe({ inputDigest: fresh.inputDigest, inputTokens: fresh.inputTokens });
    const observed = await meter.count({ input: [message('a', 4000)], tools: [] });
    expect(observed.overTolerance).toBe(0);
    expect(observed.underAt(0)).toBe(0);
    expect(observed.underAt(observed.inputTokens)).toBe(0);
  });

  it('grows the bound only above the known part', async () => {
    const meter = createTokenMeter({
      counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE),
      model: MODEL,
      capabilities: capabilitiesFor(200000, { tokenCounting: 'exact' }),
    });
    const head = message('h', 16000);
    const observed = await meter.count({ input: [head], tools: [] });
    meter.observe({ inputDigest: observed.inputDigest, inputTokens: observed.inputTokens });
    const counted = await meter.count({ input: [head, message('t', 400)], tools: [] });
    const tail = counted.inputTokens - observed.inputTokens;
    expect(counted.known).toBe(observed.inputTokens);
    expect(counted.underAt(observed.inputTokens)).toBe(0);
    expect(counted.underAt(observed.inputTokens + 1)).toBe(1);
    expect(counted.underAt(observed.inputTokens + 10)).toBe(3);
    expect(counted.underAt(counted.inputTokens)).toBe(Math.ceil(0.3 * tail));
  });

  it('keeps the under side non-decreasing for fresh, incremental and observed records', async () => {
    const random = seeded(77);
    for (const tokenCounting of ['exact', 'estimated'] as const) {
      for (let trial = 0; trial < 60; trial += 1) {
        const shape = { ratio: random.int(0, 40) / 100, minimum: random.int(0, 30) };
        const meter = createTokenMeter({
          counter: shapeCounter(() => shape, random.next() < 0.5 ? 'estimated' : 'exact'),
          model: MODEL,
          capabilities: capabilitiesFor(200000, { tokenCounting }),
        });
        const items = Array.from({ length: 4 }, (_, index) => message(String(index), random.int(40, 4000)));
        const records: MeterCount[] = [];
        const head = await meter.count({ input: items.slice(0, 2), tools: [] });
        records.push(head);
        if (random.next() < 0.7) meter.observe({ inputDigest: head.inputDigest, inputTokens: Math.round(head.inputTokens * (random.int(50, 160) / 100)) });
        records.push(await meter.count({ input: items.slice(0, 2), tools: [] }));
        records.push(await meter.count({ input: items, tools: [] }));
        for (const record of records) {
          for (let size = 1; size <= record.inputTokens + 200; size += 37) {
            expect(record.underAt(size), `${tokenCounting} ${trial}`).toBeGreaterThanOrEqual(record.underAt(size - 1));
            expect(record.freshUnderAt(size), `${tokenCounting} ${trial}`).toBeGreaterThanOrEqual(record.freshUnderAt(size - 1));
          }
        }
      }
    }
  });

  it('lets maxInputFor accept the size whose own bound the budget accepts after an incremental count', async () => {
    const meter = estimatedMeter();
    const head = message('h', 16000);
    const observed = await meter.count({ input: [head], tools: [] });
    meter.observe({ inputDigest: observed.inputDigest, inputTokens: observed.inputTokens });
    const counted = await meter.count({ input: [head, message('t', 400)], tools: [] });
    const inputBudget = counted.inputTokens + counted.underAt(counted.inputTokens);
    expect(maxInputFor({ ceiling: counted.inputTokens, inputBudget, errorBoundAt: counted.underAt })).toBe(counted.inputTokens);
  });

  it('keeps the bound of an exact counter with a fixed offset, and none at zero uncounted tokens', async () => {
    const meter = createTokenMeter({ counter: fakeCounter(30), model: MODEL, capabilities: capabilitiesFor(200000) });
    const counted = await meter.count({ input: [message('a', 400)], tools: [] });
    expect(counted.overTolerance).toBe(30);
    expect(counted.underAt(counted.inputTokens)).toBe(30);
    expect(counted.underAt(0)).toBe(0);
  });
});
