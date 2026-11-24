import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import type { InputItem, MemoryView } from '@momonga/protocol';
import { MIN_ROOM_TOKENS, buildContext, capacityFor, createTokenMeter, inputCeilingFor, measurePinned } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, BuiltContext, HistoryItem, MeterCount, TokenMeter } from '@momonga/context';
import { HOME, RAW_OUTPUT_TOOL, MODEL, PROJECT, SYSTEM_PROMPT, TASK, assistant, buildThroughLevels, call, capabilitiesFor, fakeBlobs, fakeReader, output, shapeCounter, sourcesWith, tokensOfItems, touchedFile } from './helpers.ts';
import { TEST_FENCE } from '@momonga/testkit';

const WINDOW = 8192;
const sized = capabilitiesFor(WINDOW, { tokenCounting: 'estimated', maxOutputTokens: 1024 });
const NESTED = '/proj/sub/AGENTS.md';
const touched = [touchedFile('/proj/sub/x.ts')];
const FROZEN_SPLIT_C = 6223;
const STATIC_C = 5387;

const first: HistoryItem[] = [call(1, 'c1'), output(2, 'c1', 'a'.repeat(7000)), call(3, 'c2'), output(4, 'c2', 'b'.repeat(7000)), assistant(5, 'done')];
const second: HistoryItem[] = [...first, assistant(6, 'more')];

const memoryOf = (text: string): MemoryView => ({
  id: 'mem-1',
  scope: 'user',
  origin: 'trusted',
  project: null,
  text,
  source: { kind: 'tool', sessionId: 's1', runId: 'run-1', step: 1, callId: 'm1', seq: 4 },
  createdAt: Date.UTC(2026, 10, 1),
  keptAt: Date.UTC(2026, 10, 2),
  kind: 'fact',
  state: 'active',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  keptByClassifier: null,
  status: 'unbound',
});

type Layout = 'cachePrefix' | 'default';

const inputWith = (layout: Layout, history: HistoryItem[], extra: Partial<BuildContextInput> = {}, memories: MemoryView[] = []): BuildContextInput => ({ reasoningRoom: 0,
  capabilities: sized,
  fence: TEST_FENCE,
  model: MODEL,
  sources: sourcesWith({ history, memories }),
  evicted: new Set<string>(),
  recordedReferences: new Set<string>(),
  touchedPaths: [],
  trusted: true,
  projectRoot: PROJECT,
  home: HOME,
  harnessOutputTools: [RAW_OUTPUT_TOOL],
  observedCapacity: true,
  renderedFull: new Set(['c1', 'c2']),
  ...(layout === 'cachePrefix' ? { layout } : {}),
  ...extra,
});

type Reported = { ports: BuildContextPorts; sent: MeterCount[]; first: BuiltContext };

const reportedMeter = async (firstInput: BuildContextInput, files: Record<string, string> = {}): Promise<Reported> => {
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
  const ports: BuildContextPorts = { meter, blobs: fakeBlobs(), instructions: fakeReader(files) };
  const built = await buildContext(firstInput, ports);
  meter.observe({ inputDigest: built.inputDigest, inputTokens: built.inputTokens });
  sent.length = 0;
  return { ports, sent, first: built };
};

const lastSent = (reported: Reported, built: BuiltContext): MeterCount => {
  const counted = reported.sent.findLast((entry) => entry.inputDigest === built.inputDigest);
  if (counted === undefined) throw new Error('no sent count for the built input');
  return counted;
};

const sharedItems = (a: readonly InputItem[], b: readonly InputItem[]): number => {
  let shared = 0;
  while (shared < a.length && shared < b.length && canonicalJson(a[shared]) === canonicalJson(b[shared])) shared += 1;
  return shared;
};
const noticeCodes = (built: BuiltContext): string[] => built.notices.map((notice) => notice.code);
const loadedPaths = (built: BuiltContext): string[] => built.loadedInstructions.map((loaded) => loaded.path);

describe('person item 8 (a): the boundary between the frozen C and the C of the input with the arrival', () => {
  const BOUNDARY_SIZE = 22000;

  it('refuses a nested AGENTS.md whose floor fits the frozen split C but leaves less than MIN_ROOM_TOKENS under its own C, and evicts nothing', async () => {
    const small = 500;
    const smallReported = await reportedMeter(inputWith('cachePrefix', first), { [NESTED]: 'n'.repeat(small) });
    const smallBuilt = await buildContext(inputWith('cachePrefix', second, { touchedPaths: touched }), smallReported.ports);
    const nestedItem = smallBuilt.input[1] as InputItem;
    expect(JSON.stringify(nestedItem)).toContain('n'.repeat(small));
    const floorTokens = tokensOfItems([{ type: 'message', role: 'system', content: SYSTEM_PROMPT }, nestedItem, TASK]) + (BOUNDARY_SIZE - small) / 4;
    expect(floorTokens).toBeLessThanOrEqual(FROZEN_SPLIT_C - MIN_ROOM_TOKENS);
    expect(floorTokens).toBeGreaterThan(STATIC_C - MIN_ROOM_TOKENS);

    const files = { [NESTED]: 'n'.repeat(BOUNDARY_SIZE) };
    const reported = await reportedMeter(inputWith('cachePrefix', first), files);
    const input = inputWith('cachePrefix', second, { touchedPaths: touched });
    const without = (await measurePinned(inputWith('cachePrefix', second), reported.ports)).ceiling;
    expect(without).toBe(FROZEN_SPLIT_C);
    expect(inputCeilingFor(sized)).toBe(STATIC_C);

    const { built, level } = await buildThroughLevels(input, reported.ports);
    const counted = lastSent(reported, built);

    expect(level).toBe(0);
    expect(noticeCodes(built)).toEqual(['instructions_dropped']);
    expect(loadedPaths(built)).not.toContain(NESTED);
    expect(built.evictions).toEqual([]);
    expect(counted.known).toBe(reported.first.inputTokens);
    expect(sharedItems(reported.first.input, built.input)).toBe(reported.first.input.length);
  });
});

describe('person item 8 (b): the mirror image, the same memory block in two consecutive builds, default layout', () => {
  it('ends the second build on the split with known equal to the whole first request', async () => {
    const memories = [memoryOf('m'.repeat(400))];
    const reported = await reportedMeter(inputWith('default', first, {}, memories));
    expect(reported.first.loadedMemoryIds).toEqual(['mem-1']);
    const input = inputWith('default', second, {}, memories);

    const built = await buildContext(input, reported.ports);
    const counted = lastSent(reported, built);

    expect(built.loadedMemoryIds).toEqual(['mem-1']);
    expect(built.evictions).toEqual([]);
    expect(sharedItems(reported.first.input, built.input)).toBe(reported.first.input.length);
    expect(counted.known).toBe(reported.first.inputTokens);
    expect(capacityFor(sized, counted.underAt)).toBe((await measurePinned(input, reported.ports)).ceiling);
    expect(capacityFor(sized, counted.underAt)).toBeGreaterThan(inputCeilingFor(sized));
  });
});

describe('person item 8 (c): a nested AGENTS.md that fitLayers drops, default layout', () => {
  it('reads the C of the input without the dropped file in both measurePinned and the sent count', async () => {
    const files = { [NESTED]: 'n'.repeat(40000) };
    const reported = await reportedMeter(inputWith('default', first), files);
    const input = inputWith('default', second, { touchedPaths: touched });

    const built = await buildContext(input, reported.ports);
    const counted = lastSent(reported, built);

    expect(noticeCodes(built)).toEqual(['instructions_dropped']);
    expect(loadedPaths(built)).not.toContain(NESTED);
    expect(built.evictions).toEqual([]);
    expect(capacityFor(sized, counted.underAt)).toBe((await measurePinned(input, reported.ports)).ceiling);
    expect(capacityFor(sized, counted.underAt)).toBeGreaterThan(inputCeilingFor(sized));
    expect(counted.known).toBe(reported.first.inputTokens);
  });
});
