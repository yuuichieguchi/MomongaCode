import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import type { InputItem, MemoryView } from '@momonga/protocol';
import { ContextOverflowError, buildContext, capacityFor, createTokenMeter, measurePinned } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, BuiltContext, ContextArrival, HistoryItem, MeterCount, TokenMeter } from '@momonga/context';
import { HOME, MODEL, PROJECT, assistant, call, capabilitiesFor, fakeBlobs, fakeReader, output, seeded, shapeCounter, sourcesWith, touchedFile, user } from './helpers.ts';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { TEST_FENCE } from '@momonga/testkit';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const CASES = 600;
const NESTED = '/proj/sub/AGENTS.md';

type Layout = 'cachePrefix' | 'default';
type Random = ReturnType<typeof seeded>;

type Case = {
  layout: Layout;
  window: number;
  first: HistoryItem[];
  second: HistoryItem[];
  renderedFull: Set<string>;
  firstMemories: MemoryView[];
  secondMemories: MemoryView[];
  nestedSize: number | undefined;
  arrivals: ContextArrival[];
};

const memoryOf = (id: string, text: string): MemoryView => ({
  id,
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

const MEMORY_SIZES = [100, 400, 2000, 4000, 40000];
const NESTED_SIZES = [300, 2000, 4000, 22000, 40000];

const memoriesOf = (random: Random): MemoryView[] => {
  const count = random.int(0, 3);
  return Array.from({ length: count }, (_, index) => memoryOf(`mem-${index}`, String.fromCharCode(109 + index).repeat(MEMORY_SIZES[random.int(0, MEMORY_SIZES.length - 1)] as number)));
};

const historyOf = (random: Random): { items: HistoryItem[]; callIds: string[] } => {
  const items: HistoryItem[] = [];
  const callIds: string[] = [];
  const steps = random.int(0, 4);
  let seq = 1;
  for (let step = 0; step < steps; step += 1) {
    const callId = `c${step}`;
    items.push(call(seq, callId));
    items.push(output(seq + 1, callId, String.fromCharCode(97 + step).repeat(random.int(1, 40) * 200)));
    callIds.push(callId);
    seq += 2;
  }
  items.push(assistant(seq, 'done'));
  return { items, callIds };
};

const caseOf = (random: Random): Case => {
  const layout: Layout = random.next() < 0.5 ? 'cachePrefix' : 'default';
  const { items, callIds } = historyOf(random);
  const nextSeq = items.length + 1;
  const tail = random.next() < 0.5 ? [assistant(nextSeq, 'more')] : [user(nextSeq, 'go on'), assistant(nextSeq + 1, 'more')];
  const firstMemories = random.next() < 0.5 ? memoriesOf(random) : [];
  const secondMemories = random.next() < 0.5 ? firstMemories : memoriesOf(random);
  const nestedSize = random.next() < 0.5 ? NESTED_SIZES[random.int(0, NESTED_SIZES.length - 1)] : undefined;
  const arrivals: ContextArrival[] = random.next() < 0.25 ? [{ kind: 'skill', name: 'deploy', content: 's'.repeat(random.int(1, 20) * 200) }] : [];
  return {
    layout,
    window: [8192, 16384][random.int(0, 1)] as number,
    first: items,
    second: [...items, ...tail],
    renderedFull: new Set(callIds),
    firstMemories,
    secondMemories,
    nestedSize,
    arrivals,
  };
};

const inputOf = (scenario: Case, history: HistoryItem[], memories: MemoryView[], extra: Partial<BuildContextInput> = {}): BuildContextInput => ({ reasoningRoom: 0,
  capabilities: capabilitiesFor(scenario.window, { tokenCounting: 'estimated', maxOutputTokens: 1024 }),
  fence: TEST_FENCE,
  model: MODEL,
  sources: sourcesWith({ history, memories }),
  evicted: new Set<string>(),
  recordedReferences: new Set<string>(),
  touchedPaths: [],
  trusted: true,
  projectRoot: PROJECT,
  home: HOME,
  observedCapacity: true,
  renderedFull: scenario.renderedFull,
  ...(scenario.layout === 'cachePrefix' ? { layout: scenario.layout } : {}),
  ...extra,
});

type SentCount = { counted: MeterCount; input: readonly InputItem[]; frozen: readonly InputItem[] | undefined };

const portsFor = (scenario: Case): { ports: BuildContextPorts; sent: SentCount[]; meter: TokenMeter } => {
  const capabilities = capabilitiesFor(scenario.window, { tokenCounting: 'estimated', maxOutputTokens: 1024 });
  const inner = createTokenMeter({ counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE, 'estimated'), model: MODEL, capabilities, observedCapacity: true });
  const sent: SentCount[] = [];
  const meter: TokenMeter = {
    ...inner,
    count: async (request) => {
      const counted = await inner.count(request);
      if (request.sent === true) sent.push({ counted, input: request.input, frozen: request.frozen });
      return counted;
    },
  };
  const files = scenario.nestedSize === undefined ? {} : { [NESTED]: 'n'.repeat(scenario.nestedSize) };
  return { ports: { meter, blobs: fakeBlobs(), instructions: fakeReader(files) }, sent, meter };
};

const buildOrUndefined = async (input: BuildContextInput, ports: BuildContextPorts): Promise<BuiltContext | undefined> => {
  try {
    return await buildContext(input, ports);
  } catch (error) {
    if (error instanceof ContextOverflowError) return undefined;
    throw error;
  }
};

const noticesOf = (built: BuiltContext): string => built.notices.map((notice) => notice.code).join(',');

const beginsWith = (items: readonly InputItem[], prefix: readonly InputItem[]): boolean =>
  prefix.length <= items.length && prefix.every((item, index) => canonicalJson(item) === canonicalJson(items[index]));

describe('person item 8 (d): one input, one decomposition, for every build that evicts nothing', () => {
  it('sends an input that begins with the frozen items and reads the C of measurePinned, in both layouts, with and without arrivals, memories and refusals', async () => {
    const random = seeded(20261105);
    const violations: string[] = [];
    let checked = 0;
    const seen = { cachePrefix: 0, default: 0, memories: 0, nested: 0, arrivals: 0, refused: 0 };
    for (let index = 0; index < CASES; index += 1) {
      const scenario = caseOf(random);
      const { ports, sent, meter } = portsFor(scenario);
      const firstBuilt = await buildOrUndefined(inputOf(scenario, scenario.first, scenario.firstMemories), ports);
      if (firstBuilt === undefined) continue;
      meter.observe({ inputDigest: firstBuilt.inputDigest, inputTokens: firstBuilt.inputTokens });
      sent.length = 0;
      const input = inputOf(scenario, scenario.second, scenario.secondMemories, {
        touchedPaths: scenario.nestedSize === undefined ? [] : [touchedFile('/proj/sub/x.ts')],
        arrivals: scenario.arrivals,
      });
      const built = await buildOrUndefined(input, ports);
      if (built === undefined || built.evictions.length > 0) continue;
      const last = sent.findLast((entry) => entry.counted.inputDigest === built.inputDigest);
      if (last === undefined) throw new Error(`case ${index}: no sent count for the built input`);
      checked += 1;
      seen[scenario.layout] += 1;
      if (scenario.secondMemories.length > 0) seen.memories += 1;
      if (scenario.nestedSize !== undefined) seen.nested += 1;
      if (scenario.arrivals.length > 0) seen.arrivals += 1;
      if (built.notices.some((notice) => notice.code === 'instructions_dropped' || notice.code === 'memories_dropped')) seen.refused += 1;
      const frozen = last.frozen ?? [];
      const capacity = capacityFor(input.capabilities, last.counted.underAt);
      const measured = (await measurePinned(input, ports)).ceiling;
      if (!beginsWith(built.input, frozen) || capacity !== measured) {
        const at = frozen.findIndex((item, position) => canonicalJson(item) !== canonicalJson(built.input[position]));
        violations.push(`case ${index} ${scenario.layout} mem ${scenario.secondMemories.length} same ${scenario.secondMemories === scenario.firstMemories} nested ${scenario.nestedSize} arr ${scenario.arrivals.length} notices ${noticesOf(built)} at ${at}: begins with frozen ${beginsWith(built.input, frozen)}, C ${capacity} against measurePinned ${measured}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(500);
    expect(Math.min(seen.cachePrefix, seen.default, seen.memories, seen.nested, seen.arrivals, seen.refused)).toBeGreaterThan(0);
    expect(violations.slice(0, 5)).toEqual([]);
    expect(violations).toHaveLength(0);
  });
});
