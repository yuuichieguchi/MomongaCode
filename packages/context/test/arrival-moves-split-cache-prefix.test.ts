import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import type { InputItem, MemoryView } from '@momonga/protocol';
import { ContextOverflowError, budgetFor, buildContext, capacityFor, createTokenMeter, inputCeilingFor, measurePinned } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, BuiltContext, HistoryItem, MeterCount, TokenMeter } from '@momonga/context';
import { HOME, MODEL, PROJECT, SYSTEM_PROMPT, assistant, buildThroughLevels, call, capabilitiesFor, fakeBlobs, fakeReader, output, shapeCounter, sourcesWith, tokensOfItem, tokensOfItems, touchedFile } from './helpers.ts';

const WINDOW = 8192;
const sized = capabilitiesFor(WINDOW, { tokenCounting: 'estimated', maxOutputTokens: 1024 });
const I0 = budgetFor(sized, 0).I;
const NESTED = '/proj/sub/AGENTS.md';
const touched = [touchedFile('/proj/sub/x.ts')];
const systemTokens = tokensOfItem({ type: 'message', role: 'system', content: SYSTEM_PROMPT });

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

const inputWith = (layout: 'cachePrefix' | 'default', history: HistoryItem[], extra: Partial<BuildContextInput> = {}, memories: MemoryView[] = []): BuildContextInput => ({
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
  ...(layout === 'cachePrefix' ? { layout } : {}),
  ...extra,
});

type Reported = { ports: BuildContextPorts; sent: MeterCount[]; first: BuiltContext };

const reportedMeter = async (layout: 'cachePrefix' | 'default', files: Record<string, string> = {}): Promise<Reported> => {
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
  const built = await buildContext(inputWith(layout, first), ports);
  meter.observe({ inputDigest: built.inputDigest, inputTokens: built.inputTokens });
  sent.length = 0;
  return { ports, sent, first: built };
};

const lastSent = (reported: Reported, built: BuiltContext): MeterCount => {
  const counted = reported.sent.findLast((entry) => entry.inputDigest === built.inputDigest);
  if (counted === undefined) throw new Error('no sent count for the built input');
  return counted;
};

const boundOf = (counted: MeterCount): number => counted.inputTokens + counted.underAt(counted.inputTokens);
const freshBoundOf = (counted: MeterCount): number => counted.inputTokens + counted.freshUnderAt(counted.inputTokens);
const omittedIds = (built: BuiltContext): string[] => built.evictions.filter((entry) => entry.kind === 'omitted').map((entry) => entry.callId).sort();
const sharedItems = (a: readonly InputItem[], b: readonly InputItem[]): number => {
  let shared = 0;
  while (shared < a.length && shared < b.length && canonicalJson(a[shared]) === canonicalJson(b[shared])) shared += 1;
  return shared;
};
const noticeCodes = (built: BuiltContext): string[] => built.notices.map((notice) => notice.code);
const nestedBuild = (size: number) => ({ files: { [NESTED]: 'n'.repeat(size) }, input: inputWith('cachePrefix', second, { touchedPaths: touched }) });

describe('person item 8, Q4: a nested AGENTS.md discovered inside a build under layout cachePrefix', () => {
  it('control: without the arrival, the build ends on the split with j at the whole first request and keeps all history', async () => {
    const reported = await reportedMeter('cachePrefix');
    const built = await buildContext(inputWith('cachePrefix', second), reported.ports);
    const counted = lastSent(reported, built);

    expect(counted.known).toBe(reported.first.inputTokens);
    expect(sharedItems(reported.first.input, built.input)).toBe(reported.first.input.length);
    expect(capacityFor(sized, counted.underAt)).toBeGreaterThan(inputCeilingFor(sized));
    expect(built.evictions).toEqual([]);
  });

  it('a 4000-character arrival: admitted against the frozen split C, j falls to the end of F, and the final fit test evicts history that fits by the fresh count', async () => {
    const { files, input } = nestedBuild(4000);
    const reported = await reportedMeter('cachePrefix', files);
    const frozenC = (await measurePinned(input, reported.ports)).ceiling;
    expect(frozenC).toBeGreaterThan(inputCeilingFor(sized));

    const levelZero = await buildContext(input, reported.ports).catch((caught: unknown) => caught);
    expect(levelZero).toBeInstanceOf(ContextOverflowError);
    const overflow = levelZero as ContextOverflowError;
    const atLevelZero = reported.sent.at(-1) as MeterCount;
    expect(overflow.level).toBe(0);
    expect(overflow.lastLevel).toBe(false);
    expect(overflow.evictions).toEqual([]);
    expect(overflow.ceiling).toBe(frozenC);
    expect(atLevelZero.known).toBe(systemTokens);
    expect(atLevelZero.inputTokens).toBeLessThanOrEqual(frozenC);
    expect(boundOf(atLevelZero)).toBeGreaterThan(I0);
    expect(freshBoundOf(atLevelZero)).toBeLessThanOrEqual(I0);

    reported.sent.length = 0;
    const { built, level } = await buildThroughLevels(input, reported.ports);
    const counted = lastSent(reported, built);

    expect(level).toBe(1);
    expect(omittedIds(built)).toEqual(['c1', 'c2']);
    expect(built.loadedInstructions.map((loaded) => loaded.path)).toContain(NESTED);
    expect(counted.known).toBe(systemTokens);
    expect(sharedItems(reported.first.input, built.input)).toBe(1);
    expect(capacityFor(sized, counted.underAt)).toBeLessThan(frozenC);
    expect(tokensOfItems(built.input)).toBe(built.inputTokens);
    expect(boundOf(counted)).toBeLessThanOrEqual(I0);
  });

  it('a 500-character arrival fits at level 0 with no eviction, but j still falls to the end of F and C falls with it', async () => {
    const { files, input } = nestedBuild(500);
    const reported = await reportedMeter('cachePrefix', files);
    const frozenC = (await measurePinned(input, reported.ports)).ceiling;

    const built = await buildContext(input, reported.ports);
    const counted = lastSent(reported, built);

    expect(built.evictions).toEqual([]);
    expect(counted.known).toBe(systemTokens);
    expect(sharedItems(reported.first.input, built.input)).toBe(1);
    expect(capacityFor(sized, counted.underAt)).toBeLessThan(frozenC);
  });

  it('a 40000-character arrival is refused with instructions_dropped and then j does not move', async () => {
    const { files, input } = nestedBuild(40000);
    const reported = await reportedMeter('cachePrefix', files);

    const built = await buildContext(input, reported.ports);
    const counted = lastSent(reported, built);

    expect(noticeCodes(built)).toEqual(['instructions_dropped']);
    expect(built.loadedInstructions.map((loaded) => loaded.path)).not.toContain(NESTED);
    expect(counted.known).toBe(reported.first.inputTokens);
    expect(sharedItems(reported.first.input, built.input)).toBe(reported.first.input.length);
    expect(built.evictions).toEqual([]);
  });

  it('an arrival already in the journal is part of the frozen items: j falls to the end of F, but admission and the fit test use one decomposition and nothing is evicted', async () => {
    const reported = await reportedMeter('cachePrefix');
    const input = inputWith('cachePrefix', second, { arrivals: [{ kind: 'skill', name: 'deploy', content: 's'.repeat(4000) }] });
    const frozenC = (await measurePinned(input, reported.ports)).ceiling;

    reported.sent.length = 0;
    const built = await buildContext(input, reported.ports);
    const counted = lastSent(reported, built);

    expect(built.evictions).toEqual([]);
    expect(sharedItems(reported.first.input, built.input)).toBe(1);
    expect(counted.known).toBe(0);
    expect(capacityFor(sized, counted.underAt)).toBe(frozenC);
  });
});

describe('person item 8, Q4: a memory too big for its budget, default layout', () => {
  it('lands the "1 more saved note is not shown" framing at slot 1 and moves j, with C falling and no eviction', async () => {
    const reported = await reportedMeter('default');
    const input = inputWith('default', second, {}, [memoryOf('m'.repeat(40000))]);
    const frozenC = (await measurePinned(input, reported.ports)).ceiling;

    reported.sent.length = 0;
    const built = await buildContext(input, reported.ports);
    const counted = lastSent(reported, built);
    const slotOne = built.input[1];

    expect(frozenC).toBeGreaterThan(inputCeilingFor(sized));
    expect(built.loadedMemoryIds).toEqual([]);
    expect(noticeCodes(built)).toEqual(['memories_dropped']);
    expect(slotOne).toMatchObject({ type: 'message', role: 'user' });
    expect(JSON.stringify(slotOne)).toContain('1 more saved note is not shown');
    expect(JSON.stringify(slotOne)).not.toContain('<memory ');
    expect(counted.known).toBe(systemTokens);
    expect(sharedItems(reported.first.input, built.input)).toBe(1);
    expect(capacityFor(sized, counted.underAt)).toBeLessThan(frozenC);
    expect(built.evictions).toEqual([]);
  });
});
