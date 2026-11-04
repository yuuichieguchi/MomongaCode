import { describe, expect, it } from 'vitest';
import { foldMeter } from '@momonga/context';
import type { FoldedEvent, MeterCount, MeterObservation, ObservedEvent, TokenMeter } from '@momonga/context';
import type { Capabilities, CapabilityOverride, CreateResponseBody, FunctionTool, InputItem } from '@momonga/protocol';
import { MODEL, capabilitiesFor, seeded } from './helpers.ts';
import { ESTIMATED, EXACT, meterOf, piece, pieceCounter, toolOf } from './meter-fixtures.ts';
import type { PieceCounterOptions } from './meter-fixtures.ts';

const W = 1600;

const COUNTER_A = 'a'.repeat(64);
const COUNTER_B = 'b'.repeat(64);

type Route = { target: string; fallback: boolean };

const ALIAS: Route = { target: 'primary', fallback: false };
const SECONDARY: Route = { target: 'secondary', fallback: true };

type Journal = { events: FoldedEvent[]; bodies: Map<number, CreateResponseBody> };

const emptyJournal = (): Journal => ({ events: [], bodies: new Map() });

const observed = (journal: Journal, route: Route, counter: string, observation: MeterObservation, input: readonly InputItem[], tools: readonly FunctionTool[]): void => {
  const seq = journal.events.length + 1;
  journal.bodies.set(seq, { model: MODEL, input: [...input], ...(tools.length > 0 ? { tools: [...tools] } : {}) });
  journal.events.push({ type: 'meter.observed', seq, ...route, counter, ...observation });
};

const bodyOf =
  (journal: Journal) =>
  (event: ObservedEvent): unknown => {
    if (event.seq === undefined) throw new Error('a folded meter.observed has no seq');
    const body = journal.bodies.get(event.seq);
    if (body === undefined) throw new Error(`no request body was recorded for seq ${event.seq}`);
    return body;
  };

const restored = (options: PieceCounterOptions, override: CapabilityOverride, journal: Journal, counter: string): TokenMeter => {
  const meter = meterOf(pieceCounter(options), W, override);
  meter.restore(foldMeter(journal.events, { counter, capabilities: capabilitiesFor(W, override), bodyOf: bodyOf(journal) }));
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
  it('equals the live meter of its counter after any sequence of counts, reports of two counters and claim boundaries', async () => {
    const random = seeded(4242);
    let boundaries = 0;
    let splits = 0;
    let foreign = 0;
    for (let trial = 0; trial < 60; trial += 1) {
      const { options, override } = COUNTERS[trial % COUNTERS.length] as (typeof COUNTERS)[number];
      const journal = emptyJournal();
      const live = meterOf(pieceCounter(options), W, override);
      const other = meterOf(pieceCounter(options), W, override);
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
        const spread = Math.floor(0.4 * liveCount.inputTokens);
        if (random.next() < 0.6) {
          const reported = Math.max(0, liveCount.inputTokens + random.int(-spread, spread));
          const liveObserved = live.observe({ inputDigest: liveCount.inputDigest, inputTokens: reported });
          const claimedObserved = claimed.observe({ inputDigest: claimedCount.inputDigest, inputTokens: reported });
          expect(claimedObserved, label).toEqual(liveObserved);
          observed(journal, random.next() < 0.5 ? ALIAS : SECONDARY, COUNTER_A, liveObserved, input, tools);
        }
        if (random.next() < 0.4) {
          const otherCount = await other.count({ input, tools });
          const reported = Math.max(0, otherCount.inputTokens + random.int(-spread, spread) + 17);
          observed(journal, random.next() < 0.5 ? ALIAS : SECONDARY, COUNTER_B, other.observe({ inputDigest: otherCount.inputDigest, inputTokens: reported }), input, tools);
          foreign += 1;
        }
        if (random.next() < 0.25) {
          claimed = restored(options, override, journal, COUNTER_A);
          boundaries += 1;
        }
      }
    }
    expect(boundaries).toBeGreaterThan(100);
    expect(splits).toBeGreaterThan(100);
    expect(foreign).toBeGreaterThan(300);
  });

  it('refuses observe after restore until the claim counts that input, then answers as the live meter', async () => {
    const journal = emptyJournal();
    const live = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    const input = [piece('a', 100), piece('b', 50)];
    const counted = await live.count({ input, tools: [] });
    observed(journal, ALIAS, COUNTER_A, live.observe({ inputDigest: counted.inputDigest, inputTokens: 140 }), input, []);
    const claimed = restored(ESTIMATED, { tokenCounting: 'estimated' }, journal, COUNTER_A);
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

  it('takes the request body of the latest kept report from bodyOf and asks bodyOf for nothing else', async () => {
    const journal = emptyJournal();
    const live = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    const first = [piece('a', 100)];
    const firstCount = await live.count({ input: first, tools: [] });
    observed(journal, ALIAS, COUNTER_A, live.observe({ inputDigest: firstCount.inputDigest, inputTokens: 90 }), first, []);
    const second = [piece('a', 100), piece('b', 40)];
    const secondCount = await live.count({ input: second, tools: [] });
    observed(journal, ALIAS, COUNTER_A, live.observe({ inputDigest: secondCount.inputDigest, inputTokens: 150 }), second, []);
    const foreign = [piece('z', 70)];
    const foreignCount = await meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' }).count({ input: foreign, tools: [] });
    const foreignObservation: MeterObservation = { inputDigest: foreignCount.inputDigest, itemCount: 1, counted: 70, reported: 70, kept: 70, known: 0, uncounted: 70, miss: 0, contextWindow: W, tokenCounting: 'estimated' };
    observed(journal, ALIAS, COUNTER_B, foreignObservation, foreign, []);
    const asked: number[] = [];

    const memory = foldMeter(journal.events, {
      counter: COUNTER_A,
      capabilities: capabilitiesFor(W, { tokenCounting: 'estimated' }),
      bodyOf: (event) => {
        asked.push(event.seq ?? -1);
        return bodyOf(journal)(event);
      },
    });

    expect(asked).toEqual([2]);
    expect(memory.latest?.input).toEqual(second);
    expect(memory.latest?.observation.reported).toBe(150);
    expect(memory.misses).toHaveLength(2);
  });
});

describe('the keys of the fold: the counter, the window and the calibration of the meter', () => {
  const journalOf = async (override: CapabilityOverride, route: Route = ALIAS, counter: string = COUNTER_A): Promise<Journal> => {
    const journal = emptyJournal();
    const live = meterOf(pieceCounter(ESTIMATED), W, override);
    const input = [piece('a', 200)];
    const counted = await live.count({ input, tools: [] });
    observed(journal, route, counter, live.observe({ inputDigest: counted.inputDigest, inputTokens: 250 }), input, []);
    return journal;
  };

  const next = [piece('a', 200), piece('b', 100)];

  const viewAfter = async (meter: TokenMeter) => viewOf(await meter.count({ input: next, tools: [] }));

  it('carries the report when the counter, the window and the calibration are unchanged', async () => {
    const journal = await journalOf({ tokenCounting: 'estimated' });
    const view = await viewAfter(restored(ESTIMATED, { tokenCounting: 'estimated' }, journal, COUNTER_A));
    expect(view.known).toBe(250);
    expect(view.inputTokens).toBe(350);
  });

  it.each([
    ['an alias meter folding a report of a fallback route', SECONDARY],
    ['a meter folding a report that names another target', { target: 'tertiary', fallback: false }],
  ])('carries a report of the same counter whatever its route: %s', async (_label, route) => {
    const journal = await journalOf({ tokenCounting: 'estimated' }, route);
    const view = await viewAfter(restored(ESTIMATED, { tokenCounting: 'estimated' }, journal, COUNTER_A));
    expect(view.known).toBe(250);
  });

  it('starts afresh when the report names another counter, on the same route, window and calibration', async () => {
    const journal = await journalOf({ tokenCounting: 'estimated' }, ALIAS, COUNTER_B);
    const meter = restored(ESTIMATED, { tokenCounting: 'estimated' }, journal, COUNTER_A);
    const untouched = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    expect(await viewAfter(meter)).toEqual(await viewAfter(untouched));
    expect((await viewAfter(meter)).known).toBe(0);
  });

  it.each([
    ['the context window', (capabilities: Capabilities): Capabilities => ({ ...capabilities, contextWindow: 3200 })],
    ['the configured ratio', (capabilities: Capabilities): Capabilities => ({ ...capabilities, tokenErrorRatio: 0.5 })],
    ['the counting method', (capabilities: Capabilities): Capabilities => ({ ...capabilities, tokenCounting: 'calibrated' })],
  ])('starts afresh when %s changed', async (_label, change) => {
    const journal = await journalOf({ tokenCounting: 'estimated' });
    const capabilities = change(capabilitiesFor(W, { tokenCounting: 'estimated' }));
    const override: CapabilityOverride = { tokenCounting: capabilities.tokenCounting, ...(capabilities.tokenErrorRatio === undefined ? {} : { tokenErrorRatio: capabilities.tokenErrorRatio }) };
    const meter = meterOf(pieceCounter(ESTIMATED), capabilities.contextWindow, override);
    meter.restore(foldMeter(journal.events, { counter: COUNTER_A, capabilities, bodyOf: bodyOf(journal) }));
    const untouched = meterOf(pieceCounter(ESTIMATED), capabilities.contextWindow, override);
    expect(await viewAfter(meter)).toEqual(await viewAfter(untouched));
    expect((await viewAfter(meter)).known).toBe(0);
  });
});

describe('which meter folds which events', () => {
  it('gives each meter the events of its own counter, whatever their target and fallback flag', async () => {
    const journal = emptyJournal();
    const first = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    const second = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    const one = [piece('a', 100)];
    const counted = await first.count({ input: one, tools: [] });
    observed(journal, ALIAS, COUNTER_A, first.observe({ inputDigest: counted.inputDigest, inputTokens: 100 }), one, []);
    const two = [piece('a', 100), piece('b', 100)];
    const fallback = await second.count({ input: two, tools: [] });
    observed(journal, SECONDARY, COUNTER_B, second.observe({ inputDigest: fallback.inputDigest, inputTokens: 250 }), two, []);
    const sameCounterOtherRoute = await first.count({ input: two, tools: [] });
    observed(journal, { target: 'tertiary', fallback: true }, COUNTER_A, first.observe({ inputDigest: sameCounterOtherRoute.inputDigest, inputTokens: 210 }), two, []);

    const next = [piece('a', 100), piece('b', 100), piece('c', 50)];
    const foldedA = restored(ESTIMATED, { tokenCounting: 'estimated' }, journal, COUNTER_A);
    const foldedB = restored(ESTIMATED, { tokenCounting: 'estimated' }, journal, COUNTER_B);

    expect(viewOf(await foldedA.count({ input: next, tools: [] }))).toEqual(viewOf(await first.count({ input: next, tools: [] })));
    expect(viewOf(await foldedB.count({ input: next, tools: [] }))).toEqual(viewOf(await second.count({ input: next, tools: [] })));
    expect((await foldedA.count({ input: next, tools: [] })).known).toBe(210);
    expect((await foldedB.count({ input: next, tools: [] })).known).toBe(250);
  });
});
