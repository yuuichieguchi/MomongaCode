import { describe, expect, it } from 'vitest';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import type { MemoryView, MessageInputItem } from '@momonga/protocol';
import { budgetFor, buildContext, capacityFor, createTokenMeter, inputCeilingFor, measurePinned } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, BuiltContext, HistoryItem, MeterCount, TokenMeter } from '@momonga/context';
import { HOME, MODEL, PROJECT, SYSTEM_PROMPT, assistant, buildThroughLevels, call, capabilitiesFor, fakeBlobs, fakeReader, output, shapeCounter, sourcesWith, tokensOfItem, tokensOfItems } from './helpers.ts';
import { TEST_FENCE } from '@momonga/testkit';

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
  keptAt: Date.UTC(2026, 10, 2),
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
  observedCapacity: true,
  renderedFull: new Set(['c1', 'c2']),
  fence: TEST_FENCE,
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

describe('person item 8: one input, one decomposition for a memory admitted inside a build', () => {
  it('without the memory, the build ends on the frozen split decomposition and keeps all history', async () => {
    const reported = await reportedMeter();
    const frozenC = (await measurePinned(inputWith(second, []), reported.ports)).ceiling;

    const built = await buildContext(inputWith(second, []), reported.ports);
    const counted = lastSent(reported, built);

    expect(frozenC).toBeGreaterThan(inputCeilingFor(sized));
    expect(capacityFor(sized, counted.underAt)).toBe(frozenC);
    expect(counted.known).toBeGreaterThan(tokensOfItem(systemMessage));
    expect(built.evictions).toEqual([]);
  });

  it('decides the memory before the decomposition, so level 0 sends the memory with all history on the fresh count at the static ceiling', async () => {
    const reported = await reportedMeter();
    const input = inputWith(second, [memory]);
    const ownC = (await measurePinned(input, reported.ports)).ceiling;

    const { built, level } = await buildThroughLevels(input, reported.ports);
    const counted = lastSent(reported, built);

    expect(built.loadedMemoryIds).toEqual(['mem-1']);
    expect(omittedIds(built)).toEqual([]);
    expect(level).toBe(0);
    expect(capacityFor(sized, counted.underAt)).toBe(ownC);
    expect(ownC).toBe(inputCeilingFor(sized));
    expect(counted.known).toBe(0);
    expect(tokensOfItems(built.input)).toBe(built.inputTokens);
  });

  it('sends a request whose bound fits I0', async () => {
    const reported = await reportedMeter();
    const { built } = await buildThroughLevels(inputWith(second, [memory]), reported.ports);
    const counted = lastSent(reported, built);

    expect(tokensOfItems(built.input)).toBeLessThanOrEqual(I0);
    expect(boundOf(counted)).toBeLessThanOrEqual(I0);
  });
});
