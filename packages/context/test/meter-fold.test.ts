import { describe, expect, it } from 'vitest';
import { foldMeter } from '@momonga/context';
import type { MeterCount, MeterObservation, TokenMeter } from '@momonga/context';
import type { Capabilities, CapabilityOverride, FunctionTool, InputItem, RunEventPayload } from '@momonga/protocol';
import { MODEL, capabilitiesFor, seeded } from './helpers.ts';
import { ESTIMATED, EXACT, meterOf, piece, pieceCounter, toolOf } from './meter-fixtures.ts';
import type { PieceCounterOptions } from './meter-fixtures.ts';

const W = 1600;

type Journal = RunEventPayload[];

const requested = (journal: Journal, input: readonly InputItem[], tools: readonly FunctionTool[]): void => {
  journal.push({
    type: 'model.requested',
    step: journal.length,
    attempt: 1,
    digest: `request-${journal.length}`,
    body: { model: MODEL, input: [...input], ...(tools.length > 0 ? { tools: [...tools] } : {}) },
  });
};

type Route = { target: string; fallback: boolean };

const ALIAS: Route = { target: 'primary', fallback: false };
const SECONDARY: Route = { target: 'secondary', fallback: true };

const observed = (journal: Journal, route: Route, observation: MeterObservation): void => {
  journal.push({ type: 'meter.observed', ...route, ...observation });
};

const sourceOf = (route: Route) => (route.fallback ? { fallbackTarget: route.target } : {});

const restored = (options: PieceCounterOptions, override: CapabilityOverride, journal: Journal, route: Route): TokenMeter => {
  const meter = meterOf(pieceCounter(options), W, override);
  meter.restore(foldMeter(journal, { capabilities: capabilitiesFor(W, override), ...sourceOf(route) }));
  return meter;
};

const viewOf = (counted: MeterCount) => {
  const c = counted.inputTokens;
  const points = [0, 1, Math.floor(c / 2), c, c + 37, 2 * c + 5];
  return {
    inputTokens: c,
    inputDigest: counted.inputDigest,
    known: counted.known,
    uncounted: counted.uncounted,
    overTolerance: counted.overTolerance,
    under: points.map((m) => counted.underAt(m)),
    fresh: points.map((m) => counted.freshUnderAt(m)),
  };
};

const COUNTERS: readonly { options: PieceCounterOptions; override: CapabilityOverride }[] = [
  { options: EXACT, override: {} },
  { options: ESTIMATED, override: { tokenCounting: 'estimated' } },
  { options: { method: 'calibrated', shape: { ratio: 0.25, minimum: 1 } }, override: { tokenCounting: 'calibrated', tokenErrorRatio: 0.25 } },
  { options: EXACT, override: { tokenErrorRatio: 0.125 } },
];

const TOOLS = [toolOf('Read', 300)];

describe('the meter is a fold of the journal', () => {
  it('equals the live meter after any sequence of counts, reports and claim boundaries', async () => {
    const random = seeded(4242);
    let boundaries = 0;
    let splits = 0;
    for (let trial = 0; trial < 60; trial += 1) {
      const { options, override } = COUNTERS[trial % COUNTERS.length] as (typeof COUNTERS)[number];
      const journal: Journal = [];
      const live = meterOf(pieceCounter(options), W, override);
      let claimed = meterOf(pieceCounter(options), W, override);
      let names = 0;
      const fresh = (): InputItem => piece(`n${(names += 1)}`, random.int(1, 120));
      let input: InputItem[] = [fresh(), fresh()];
      let tools: FunctionTool[] = [];
      for (let op = 0; op < 25; op += 1) {
        const roll = random.next();
        if (roll < 0.35) input = [...input, ...Array.from({ length: random.int(1, 3) }, fresh)];
        else if (roll < 0.5) input = [...input.slice(0, random.int(1, input.length)), fresh(), fresh()];
        else if (roll < 0.62 && input.length > 1) input = input.filter((_, index) => index !== random.int(1, input.length - 1));
        else if (roll < 0.68) tools = tools.length > 0 ? [] : TOOLS;
        const label = JSON.stringify({ trial, op });
        const liveCount = await live.count({ input, tools });
        const claimedCount = await claimed.count({ input, tools });
        expect(viewOf(claimedCount), label).toEqual(viewOf(liveCount));
        if (liveCount.known > 0) splits += 1;
        if (random.next() < 0.7) {
          requested(journal, input, tools);
          const reported = Math.max(0, liveCount.inputTokens + random.int(-Math.floor(0.4 * liveCount.inputTokens), Math.floor(0.4 * liveCount.inputTokens)));
          const liveObserved = live.observe({ inputDigest: liveCount.inputDigest, inputTokens: reported });
          const claimedObserved = claimed.observe({ inputDigest: claimedCount.inputDigest, inputTokens: reported });
          expect(claimedObserved, label).toEqual(liveObserved);
          observed(journal, ALIAS, liveObserved);
        }
        if (random.next() < 0.25) {
          claimed = restored(options, override, journal, ALIAS);
          boundaries += 1;
        }
      }
    }
    expect(boundaries).toBeGreaterThan(100);
    expect(splits).toBeGreaterThan(100);
  });

  it('refuses observe after restore until the claim counts that input, then answers as the live meter', async () => {
    const journal: Journal = [];
    const live = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    const input = [piece('a', 100), piece('b', 50)];
    requested(journal, input, []);
    const counted = await live.count({ input, tools: [] });
    observed(journal, ALIAS, live.observe({ inputDigest: counted.inputDigest, inputTokens: 140 }));
    const claimed = restored(ESTIMATED, { tokenCounting: 'estimated' }, journal, ALIAS);
    const other = await meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' }).count({ input: [piece('z', 30)], tools: [] });

    expect(() => claimed.observe({ inputDigest: counted.inputDigest, inputTokens: 250 })).toThrow(counted.inputDigest);
    expect(() => claimed.observe({ inputDigest: other.inputDigest, inputTokens: 250 })).toThrow(other.inputDigest);

    const claimedCount = await claimed.count({ input, tools: [] });
    const liveCount = await live.count({ input, tools: [] });
    expect(viewOf(claimedCount)).toEqual(viewOf(liveCount));
    const answered = claimed.observe({ inputDigest: claimedCount.inputDigest, inputTokens: 250 });

    expect(answered).toEqual(live.observe({ inputDigest: liveCount.inputDigest, inputTokens: 250 }));
    expect(answered.reported).toBe(250);
    expect(answered.kept).toBe(250);
  });
});

describe('the keys of the fold: contextWindow, tokenErrorRatio and tokenCounting of the current capabilities', () => {
  const journalOf = async (override: CapabilityOverride): Promise<Journal> => {
    const journal: Journal = [];
    const live = meterOf(pieceCounter(ESTIMATED), W, override);
    const input = [piece('a', 200)];
    requested(journal, input, []);
    const counted = await live.count({ input, tools: [] });
    observed(journal, ALIAS, live.observe({ inputDigest: counted.inputDigest, inputTokens: 250 }));
    return journal;
  };

  const next = [piece('a', 200), piece('b', 100)];

  const viewAfter = async (meter: TokenMeter) => viewOf(await meter.count({ input: next, tools: [] }));

  it('carries the report when window, ratio and counting are unchanged', async () => {
    const journal = await journalOf({ tokenCounting: 'estimated' });
    const view = await viewAfter(restored(ESTIMATED, { tokenCounting: 'estimated' }, journal, ALIAS));
    expect(view.known).toBe(250);
    expect(view.inputTokens).toBe(350);
  });

  it.each([
    ['the context window', (capabilities: Capabilities): Capabilities => ({ ...capabilities, contextWindow: 3200 })],
    ['the configured ratio', (capabilities: Capabilities): Capabilities => ({ ...capabilities, tokenErrorRatio: 0.5 })],
    ['the counting method', (capabilities: Capabilities): Capabilities => ({ ...capabilities, tokenCounting: 'calibrated' })],
  ])('starts afresh when %s changed', async (_label, change) => {
    const journal = await journalOf({ tokenCounting: 'estimated' });
    const capabilities = change(capabilitiesFor(W, { tokenCounting: 'estimated' }));
    const counter = pieceCounter(ESTIMATED);
    const meter = meterOf(counter, capabilities.contextWindow, { tokenCounting: capabilities.tokenCounting, ...(capabilities.tokenErrorRatio === undefined ? {} : { tokenErrorRatio: capabilities.tokenErrorRatio }) });
    meter.restore(foldMeter(journal, { capabilities }));
    const untouched = meterOf(pieceCounter(ESTIMATED), capabilities.contextWindow, { tokenCounting: capabilities.tokenCounting, ...(capabilities.tokenErrorRatio === undefined ? {} : { tokenErrorRatio: capabilities.tokenErrorRatio }) });
    expect(await viewAfter(meter)).toEqual(await viewAfter(untouched));
    expect((await viewAfter(meter)).known).toBe(0);
  });
});

describe('which meter folds which events', () => {
  it('gives the alias meter the events with fallback false and each fallback meter the events with fallback true for its target', async () => {
    const journal: Journal = [];
    const primary = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    const secondary = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    const first = [piece('a', 100)];
    requested(journal, first, []);
    const counted = await primary.count({ input: first, tools: [] });
    observed(journal, ALIAS, primary.observe({ inputDigest: counted.inputDigest, inputTokens: 100 }));
    const second = [piece('a', 100), piece('b', 100)];
    requested(journal, second, []);
    const fallback = await secondary.count({ input: second, tools: [] });
    observed(journal, SECONDARY, secondary.observe({ inputDigest: fallback.inputDigest, inputTokens: 250 }));

    const tertiary = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    requested(journal, second, []);
    const other = await tertiary.count({ input: second, tools: [] });
    observed(journal, { target: 'tertiary', fallback: true }, tertiary.observe({ inputDigest: other.inputDigest, inputTokens: 210 }));

    const next = [piece('a', 100), piece('b', 100), piece('c', 50)];
    const foldedPrimary = restored(ESTIMATED, { tokenCounting: 'estimated' }, journal, ALIAS);
    const foldedSecondary = restored(ESTIMATED, { tokenCounting: 'estimated' }, journal, SECONDARY);

    expect(viewOf(await foldedPrimary.count({ input: next, tools: [] }))).toEqual(viewOf(await primary.count({ input: next, tools: [] })));
    expect(viewOf(await foldedSecondary.count({ input: next, tools: [] }))).toEqual(viewOf(await secondary.count({ input: next, tools: [] })));
    expect((await foldedPrimary.count({ input: next, tools: [] })).known).toBe(100);
    expect((await foldedSecondary.count({ input: next, tools: [] })).known).toBe(250);
  });
});
