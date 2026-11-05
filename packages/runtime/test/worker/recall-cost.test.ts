import { describe, expect, it } from 'vitest';
import { buildContext, inputCeilingFor, memoryBudgetFor } from '@momonga/context';
import { recallOrder } from '@momonga/memory';
import type { MemoryRecord, MemoryView } from '@momonga/protocol';
import { harness as contextHarness, inputFor, sourcesWith } from '../../../context/test/helpers.ts';
import { RECORDED_SHA, SIGNAL, countStatements, newCounter, portFor, seededStore } from '../memory/recall-fixture.ts';
import { capabilitiesFor } from './harness.ts';

const SIZES = [50, 500, 5000, 50000] as const;

const SHARE = 0.25;

const CAPABILITIES = capabilitiesFor(8000);

const CAPACITY = { capabilities: CAPABILITIES, memoryShare: SHARE };

const LARGEST_BUDGET = memoryBudgetFor(inputCeilingFor(CAPABILITIES), SHARE);

const noteText = (index: number): string => `note ${index} about the build: ${'keep the generated parser in sync '.repeat(Math.ceil(LARGEST_BUDGET / 34))}`.slice(0, LARGEST_BUDGET);

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const recallAt = async (size: number, query = 'unrelated words') => {
  const seeded = seededStore(size, noteText);
  const counter = newCounter();
  const port = portFor(seeded.store, counter);
  const measured = await countStatements(async () => {
    const set = await port.load(seeded.session, SIGNAL);
    await set.prepare({ query, capacity: CAPACITY });
    return set;
  });
  return { counter, statements: measured.statements, set: measured.result, seeded };
};

describe('recall cost does not grow with the store', () => {
  it('recall checks at most the notes that can fill the budget, at 50, 500, 5000 and 50000 notes', async () => {
    let previous: number | undefined;
    for (const size of SIZES) {
      const { counter, set } = await recallAt(size);
      expect(counter.calls).toBeGreaterThan(0);
      expect(counter.calls).toBeLessThan(SIZES[0]);
      expect(set.ranked().length).toBeGreaterThan(0);
      if (previous !== undefined) expect(counter.calls).toBe(previous);
      previous = counter.calls;
    }
  }, 600_000);

  it('recall issues the same number of statements at four store sizes', async () => {
    let previous: number | undefined;
    for (const size of SIZES) {
      const { statements, counter } = await recallAt(size);
      expect(counter.calls).toBeGreaterThan(0);
      if (previous !== undefined) expect(statements).toBe(previous);
      previous = statements;
    }
  }, 600_000);

  it('statements and rows scanned are equal at four store sizes when every note matches a common term', async () => {
    let previous: { statements: number; calls: number } | undefined;
    for (const size of SIZES) {
      const { statements, counter } = await recallAt(size, 'generated parser');
      expect(counter.calls).toBeGreaterThan(0);
      if (previous !== undefined) expect({ statements, calls: counter.calls }).toEqual(previous);
      previous = { statements, calls: counter.calls };
    }
  }, 600_000);

  it('evidence checks of a page never overlap', async () => {
    const { counter } = await recallAt(SIZES[0]);
    expect(counter.calls).toBeGreaterThan(1);
    expect(counter.maxInFlight).toBe(1);
  });

  it('a note checked in this claim is not checked again by a later build in the same claim', async () => {
    const { counter, set } = await recallAt(SIZES[0]);
    const first = counter.calls;
    expect(first).toBeGreaterThan(0);
    await set.prepare({ query: 'unrelated words', capacity: CAPACITY });
    await set.prepare({ query: 'other words entirely', capacity: CAPACITY });
    expect(counter.calls).toBe(first);
  });

  it('a pinned note outside the prefix is still returned, and the pinned message is unchanged', async () => {
    const seeded = seededStore(200, noteText);
    const pinned = seeded.store.memories.addByCommand({ scope: 'project', project: seeded.project, text: 'the pinned note', evidence: [] });
    seeded.store.memories.observe(pinned.id, 'stale');
    const counter = newCounter();
    const set = await portFor(seeded.store, counter).load(seeded.session, SIGNAL);
    await set.prepare({ query: 'unrelated words', capacity: CAPACITY, pinnedIds: [pinned.id] });
    const ranked = set.ranked();
    expect(ranked.map((memory) => memory.id)).toContain(pinned.id);
    const capabilities = CAPABILITIES;
    const { ports } = contextHarness(capabilities);
    const withPrefix = await buildContext(inputFor(capabilities, { memoryShare: SHARE, pinnedMemoryIds: [pinned.id], sources: sourcesWith({ memories: ranked }) }), ports);
    const withOnlyPinned = await buildContext(
      inputFor(capabilities, { memoryShare: SHARE, pinnedMemoryIds: [pinned.id], sources: sourcesWith({ memories: ranked.filter((memory) => memory.id === pinned.id) }) }),
      ports,
    );
    expect(withPrefix.loadedMemoryIds).toEqual([pinned.id]);
    expect(withPrefix.loadedMemoryIds).toEqual(withOnlyPinned.loadedMemoryIds);
  });

  it('hasMore is true when the prefix stopped before the end and false when every note was read', async () => {
    const big = await recallAt(SIZES[0]);
    expect(big.set.hasMore()).toBe(true);
    const small = await recallAt(1);
    expect(small.set.hasMore()).toBe(false);
  });

  it('rank gives the build exactly what the full ranking would let it include', async () => {
    const random = seededRandom(46);
    for (let trial = 0; trial < 12; trial += 1) {
      const count = 3 + Math.floor(random() * 60);
      const lengths = Array.from({ length: count }, () => 20 + Math.floor(random() * LARGEST_BUDGET));
      const seeded = seededStore(count, (index) => `note ${index} ${'w'.repeat(lengths[index] ?? 20)}`);
      const window = [8000, 12000, 16000][Math.floor(random() * 3)] ?? 8000;
      const capabilities = capabilitiesFor(window);
      const counter = newCounter();
      const set = await portFor(seeded.store, counter).load(seeded.session, SIGNAL);
      await set.prepare({ query: 'unrelated words', capacity: { capabilities, memoryShare: SHARE } });
      const prefix = set.ranked();
      const records = seeded.store.memories.list({ project: seeded.project }) as MemoryRecord[];
      const full: MemoryView[] = recallOrder(records, new Set()).map((record) => ({ ...record, status: 'verified' as const }));
      expect(prefix.every((memory) => memory.evidence.every((entry) => entry.kind !== 'file' || entry.sha256 === RECORDED_SHA))).toBe(true);
      const { ports } = contextHarness(capabilities);
      const fromPrefix = await buildContext(inputFor(capabilities, { memoryShare: SHARE, sources: sourcesWith({ memories: prefix }) }), ports);
      const fromFull = await buildContext(inputFor(capabilities, { memoryShare: SHARE, sources: sourcesWith({ memories: full }) }), ports);
      expect(fromPrefix.loadedMemoryIds).toEqual(fromFull.loadedMemoryIds);
    }
  }, 600_000);
});
