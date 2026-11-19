import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import type { InputItem, MemoryView } from '@momonga/protocol';
import { buildContext, createTokenMeter } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, HistoryItem } from '@momonga/context';
import { HOME, MODEL, PROJECT, READ_TOOL, call, capabilitiesFor, fakeBlobs, fakeCounter, fakeReader, output, seeded, sourcesWith, tokensOfItem, tokensOfTool, touchedFile } from './helpers.ts';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { TEST_FENCE } from '@momonga/testkit';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const WORDS = ['river', 'garden', 'lantern', 'harbor', 'orchard', 'violin', 'bridge', 'meadow', 'compass', 'library', 'village', 'window', 'quiet', 'old', 'bright', 'narrow'];

const fillerOf = (chars: number, seed: number): string => {
  const random = seeded(seed);
  let text = '';
  while (text.length < chars) text += `${WORDS[random.int(0, WORDS.length - 1)]} `;
  return text.slice(0, chars);
};

const SIZES = { rootAgents: 3000, memory: 2000, arrival: 4000, toolOutput: 2000 };
const WINDOW = 200_000;
const CACHED_PRICE = 0.1;
const NESTED = '/proj/sub/AGENTS.md';
const ROOT_AGENTS = '/proj/AGENTS.md';
const ARRIVAL_TEXT = fillerOf(SIZES.arrival, 3);
const capabilities = capabilitiesFor(WINDOW);

type Placement = 'today' | 'd1' | 'd2';
type Layout = 'default' | 'cachePrefix';
type Row = { step: number; total: number; cacheable: number; uncached: number };
type Totals = { requests: number; total: number; cacheable: number; uncached: number; weighted: number };

const memory: MemoryView = {
  id: 'mem-1',
  scope: 'user',
  origin: 'trusted',
  project: null,
  text: fillerOf(SIZES.memory, 2),
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
};

const arrivalMessage: InputItem = { type: 'message', role: 'developer', content: `Contents of ${NESTED}:\n${ARRIVAL_TEXT}` };

const historyFor = (requestStep: number, arrivalStep: number, placement: Placement): HistoryItem[] => {
  const items: HistoryItem[] = [];
  for (let step = 1; step < requestStep; step += 1) {
    items.push(call(2 * step + 10, `c${step}`), output(2 * step + 11, `c${step}`, fillerOf(SIZES.toolOutput, 100 + step)));
    if (placement === 'd1' && step === arrivalStep - 1) items.push({ seq: 2 * step + 12, item: arrivalMessage });
  }
  return items;
};

const inputFor = (requestStep: number, arrivalStep: number, placement: Placement, layout: Layout): BuildContextInput => {
  const arrived = requestStep >= arrivalStep;
  const cachePrefix = layout === 'cachePrefix';
  return { reasoningRoom: 0,
    capabilities,
    fence: TEST_FENCE,
    model: MODEL,
    sources: sourcesWith({ history: historyFor(requestStep, arrivalStep, placement), tools: [READ_TOOL], memories: [memory] }),
    evicted: new Set<string>(),
    recordedReferences: new Set<string>(),
    touchedPaths: placement === 'today' && arrived && !cachePrefix ? [touchedFile('/proj/sub/x.ts')] : [],
    trusted: true,
    projectRoot: PROJECT,
    home: HOME,
    observedCapacity: true,
    renderedFull: new Set(Array.from({ length: requestStep }, (_, index) => `c${index + 1}`)),
    ...(cachePrefix ? { layout: 'cachePrefix' as const, pinnedMemoryIds: ['mem-1'] } : {}),
    ...(cachePrefix && placement === 'today' && arrived ? { arrivals: [{ kind: 'instructions' as const, path: NESTED, content: ARRIVAL_TEXT }] } : {}),
    ...(placement === 'd2' && arrived ? { trailing: [arrivalMessage] } : {}),
  };
};

type Unit = { key: string; tokens: number };

const unitsOf = (built: { tools: readonly (typeof READ_TOOL)[]; input: readonly InputItem[] }): Unit[] => [
  ...built.tools.map((tool) => ({ key: canonicalJson(tool), tokens: tokensOfTool(tool) })),
  ...built.input.map((item) => ({ key: canonicalJson(item), tokens: tokensOfItem(item) })),
];

const simulate = async (steps: number, arrivalStep: number, placement: Placement, layout: Layout): Promise<Row[]> => {
  const meter = createTokenMeter({ counter: fakeCounter(0), model: MODEL, capabilities, observedCapacity: true });
  const ports: BuildContextPorts = {
    meter,
    blobs: fakeBlobs(),
    instructions: fakeReader({ [ROOT_AGENTS]: fillerOf(SIZES.rootAgents, 1), [NESTED]: ARRIVAL_TEXT }),
  };
  const rows: Row[] = [];
  let previous: Unit[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const built = await buildContext(inputFor(step, arrivalStep, placement, layout), ports);
    expect(built.evictions).toEqual([]);
    const units = unitsOf(built);
    const total = units.reduce((sum, unit) => sum + unit.tokens, 0);
    expect(total).toBe(built.inputTokens);
    let shared = 0;
    while (shared < units.length && shared < previous.length && units[shared]?.key === previous[shared]?.key) shared += 1;
    const cacheable = units.slice(0, shared).reduce((sum, unit) => sum + unit.tokens, 0);
    meter.observe({ inputDigest: built.inputDigest, inputTokens: built.inputTokens });
    rows.push({ step, total, cacheable, uncached: total - cacheable });
    previous = units;
  }
  return rows;
};

const totalsOf = (rows: readonly Row[]): Totals => {
  const cacheable = rows.reduce((sum, row) => sum + row.cacheable, 0);
  const uncached = rows.reduce((sum, row) => sum + row.uncached, 0);
  return { requests: rows.length, total: cacheable + uncached, cacheable, uncached, weighted: Math.round(uncached + CACHED_PRICE * cacheable) };
};

const PLACEMENTS: Placement[] = ['today', 'd1', 'd2'];
const LAYOUTS: Layout[] = ['default', 'cachePrefix'];
const RUNS = [
  { steps: 10, arrivalStep: 2 },
  { steps: 10, arrivalStep: 5 },
  { steps: 30, arrivalStep: 2 },
  { steps: 30, arrivalStep: 15 },
];

describe('person item 8, Q2: cache cost of one arrival by placement', () => {
  it('a placement after the cached prefix costs no more uncached input than today, and one before it costs more', async () => {
    for (const layout of LAYOUTS) {
      for (const { steps, arrivalStep } of RUNS) {
        const control = totalsOf(await simulate(steps, steps + 1, 'today', layout));
        const totalsBy = new Map<Placement, Totals>();
        for (const placement of PLACEMENTS) {
          const rows = await simulate(steps, arrivalStep, placement, layout);
          const totals = totalsOf(rows);
          totalsBy.set(placement, totals);
        }
        const [today, d1, d2] = PLACEMENTS.map((placement) => totalsBy.get(placement) as Totals) as [Totals, Totals, Totals];
        expect(d1.uncached).toBeLessThanOrEqual(today.uncached);
        expect(today.uncached).toBeLessThan(d2.uncached);
        expect(d2.cacheable).toBe(control.cacheable);
        expect(d1.weighted).toBeLessThan(d2.weighted);
      }
    }
  });
});
