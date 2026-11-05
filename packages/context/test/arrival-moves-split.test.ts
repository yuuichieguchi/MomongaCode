import { describe, expect, it } from 'vitest';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import type { MemoryView, MessageInputItem } from '@momonga/protocol';
import { ContextOverflowError, budgetFor, buildContext, capacityFor, createTokenMeter, inputCeilingFor, measurePinned } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, BuiltContext, HistoryItem, MeterCount, TokenMeter } from '@momonga/context';
import { HOME, MODEL, PROJECT, SYSTEM_PROMPT, assistant, buildThroughLevels, call, capabilitiesFor, fakeBlobs, fakeReader, output, shapeCounter, sourcesWith, tokensOfItem, tokensOfItems } from './helpers.ts';

const WINDOW = 8192;
const sized = capabilitiesFor(WINDOW, { tokenCounting: 'estimated', maxOutputTokens: 1024 });
const I0 = budgetFor(sized, 0).I;
const systemMessage: MessageInputItem = { type: 'message', role: 'system', content: SYSTEM_PROMPT };

const memoryOf = (text: string): MemoryView => ({
  id: 'mem-1',
  scope: 'user',
  origin: 'trusted',
  project: null,
  text,
  source: { kind: 'tool', sessionId: 's1', runId: 'run-1', step: 1, callId: 'm1', seq: 4 },
  createdAt: Date.UTC(2026, 10, 1),
  lastUsedAt: Date.UTC(2026, 10, 2),
  kind: 'fact',
  state: 'active',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  status: 'unbound',
});

const first: HistoryItem[] = [call(1, 'c1'), output(2, 'c1', 'a'.repeat(7000)), call(3, 'c2'), output(4, 'c2', 'b'.repeat(7000)), assistant(5, 'done')];
const second: HistoryItem[] = [...first, assistant(6, 'more')];
const memory = memoryOf('m'.repeat(4000));

const inputWith = (history: HistoryItem[], memories: MemoryView[]): BuildContextInput => ({
  capabilities: sized,
  model: MODEL,
  sources: sourcesWith({ history, memories }),
  evicted: new Set<string>(),
  recordedReferences: new Set<string>(),
  touchedPaths: [],
  trusted: true,
  projectRoot: PROJECT,
  home: HOME,
  keepRecentTurns: 1,
  observedCapacity: true,
  renderedFull: new Set(['c1', 'c2']),
});

type Reported = { ports: BuildContextPorts; sent: MeterCount[] };

const reportedMeter = async (): Promise<Reported> => {
  const inner = createTokenMeter({ counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE, 'estimated'), model: MODEL, capabilities: sized, observedCapacity: true });
  const sent: MeterCount[] = [];
  const meter: TokenMeter = {
    ...inner,
    count: async (request) => {
      const counted = await inner.count(request);
      if (request.sent === true) sent.push(counted);
      return counted;
    },
  };
  const ports: BuildContextPorts = { meter, blobs: fakeBlobs(), instructions: fakeReader({}) };
  const built = await buildContext(inputWith(first, []), ports);
  meter.observe({ inputDigest: built.inputDigest, inputTokens: built.inputTokens });
  sent.length = 0;
  return { ports, sent };
};

const lastSent = (reported: Reported, built: BuiltContext): MeterCount => {
  const counted = reported.sent.findLast((entry) => entry.inputDigest === built.inputDigest);
  if (counted === undefined) throw new Error('no sent count for the built input');
  return counted;
};

const boundOf = (counted: MeterCount): number => counted.inputTokens + counted.underAt(counted.inputTokens);
const omittedIds = (built: BuiltContext): string[] => built.evictions.filter((entry) => entry.kind === 'omitted').map((entry) => entry.callId).sort();

describe('person item 8 measurement: a memory admitted inside a build moves the split point j', () => {
  it('without the memory, the build ends on the frozen split decomposition and keeps all history', async () => {
    const reported = await reportedMeter();
    const frozenC = (await measurePinned(inputWith(second, [memory]), reported.ports)).ceiling;

    const built = await buildContext(inputWith(second, []), reported.ports);
    const counted = lastSent(reported, built);

    expect(frozenC).toBeGreaterThan(inputCeilingFor(sized));
    expect(capacityFor(sized, counted.underAt)).toBe(frozenC);
    expect(counted.known).toBeGreaterThan(tokensOfItem(systemMessage));
    expect(built.evictions).toEqual([]);
  });

  it('admits the memory against the frozen split C, ends on a decomposition with j at slot 1, and the final fit test evicts history', async () => {
    const reported = await reportedMeter();
    const frozenC = (await measurePinned(inputWith(second, [memory]), reported.ports)).ceiling;
    expect(frozenC).toBeGreaterThan(inputCeilingFor(sized));

    const levelZero = await buildContext(inputWith(second, [memory]), reported.ports).catch((caught: unknown) => caught);
    expect(levelZero).toBeInstanceOf(ContextOverflowError);
    const overflow = levelZero as ContextOverflowError;
    const atLevelZero = reported.sent.at(-1) as MeterCount;
    expect(overflow.level).toBe(0);
    expect(overflow.lastLevel).toBe(false);
    expect({ evictions: overflow.evictions, compaction: overflow.compaction, blocked: overflow.compactionBlockedBy?.reason }).toEqual({ evictions: [], compaction: undefined, blocked: 'no_step_boundary_outside_protection' });
    expect(overflow.ceiling).toBe(frozenC);
    expect(overflow.inputTokens).toBe(atLevelZero.inputTokens);
    expect(atLevelZero.known).toBe(tokensOfItem(systemMessage));
    expect(boundOf(atLevelZero)).toBeGreaterThan(I0);
    expect(atLevelZero.inputTokens + atLevelZero.freshUnderAt(atLevelZero.inputTokens)).toBeLessThanOrEqual(I0);
    expect(atLevelZero.inputTokens).toBeLessThanOrEqual(frozenC);

    reported.sent.length = 0;
    const { built, level } = await buildThroughLevels(inputWith(second, [memory]), reported.ports);
    const counted = lastSent(reported, built);

    expect(level).toBe(1);
    expect(built.loadedMemoryIds).toEqual(['mem-1']);
    expect(omittedIds(built)).toEqual(['c1', 'c2']);
    expect(counted.known).toBe(tokensOfItem(systemMessage));
    expect(capacityFor(sized, counted.underAt)).toBeLessThan(frozenC);
    expect(tokensOfItems(built.input)).toBe(built.inputTokens);
    expect(built.inputTokens).toBeLessThan(WINDOW);
  });

  it('sends a request whose bound fits I0', async () => {
    const reported = await reportedMeter();
    const { built } = await buildThroughLevels(inputWith(second, [memory]), reported.ports);
    const counted = lastSent(reported, built);

    expect(tokensOfItems(built.input)).toBeLessThanOrEqual(I0);
    expect(boundOf(counted)).toBeLessThanOrEqual(I0);
  });
});
