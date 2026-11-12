import { describe, expect, it } from 'vitest';
import { buildContext, budgetFor, capacityFor, inputCeilingFor } from '@momonga/context';
import type { BuildContextInput, BuiltContext } from '@momonga/context';
import type { Capabilities, MemoryView } from '@momonga/protocol';
import { HOME, MODEL, PROJECT, SYSTEM_PROMPT, TASK, capabilitiesFor, fakeBlobs, fakeReader, sourcesWith, touchedFile, user } from './helpers.ts';
import { weightMeter, weightOf } from './weight-meter.ts';
import type { UnderRule } from './weight-meter.ts';
import { TEST_FENCE } from '@momonga/testkit';

const WINDOW = 8192;
const OUTPUT = 1024;
const NESTED_AGENTS = '/proj/src/AGENTS.md';

const estimated = capabilitiesFor(WINDOW, { tokenCounting: 'estimated', maxOutputTokens: OUTPUT });
const exactAtWholeBudget = capabilitiesFor(WINDOW, { tokenCounting: 'exact', maxOutputTokens: OUTPUT });
const exactAtHalfBudget = capabilitiesFor(WINDOW, { tokenCounting: 'exact', tokenErrorRatio: 1, maxOutputTokens: OUTPUT });

const nothingUnder: UnderRule = () => 0;
const wholeUnder: UnderRule = (tokens) => tokens;

const memoryOf = (index: number): MemoryView => ({
  id: `mem-${index}`,
  scope: 'user',
  origin: 'trusted',
  project: null,
  text: `Note number ${index}: prefer small commits and keep every change reviewable in one sitting.`,
  source: { kind: 'tool', sessionId: 's1', runId: `run-${index}`, step: index, callId: `c${index}`, seq: index + 3 },
  createdAt: Date.UTC(2026, 10, 1, 0, 0, index),
  keptAt: Date.UTC(2026, 10, 2, 0, 0, index),
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

const MEMORIES = Array.from({ length: 40 }, (_, index) => memoryOf(index + 1));

const floorTokens = weightOf({ type: 'message', role: 'system', content: SYSTEM_PROMPT }) + weightOf(TASK);

type Extra = { memories?: readonly MemoryView[]; files?: Record<string, string>; observed: boolean };

const buildWith = (capabilities: Capabilities, under: UnderRule, { memories, files, observed }: Extra): Promise<BuiltContext> => {
  const input: BuildContextInput & { observedCapacity?: true } = {
    capabilities,
    fence: TEST_FENCE,
    model: MODEL,
    sources: sourcesWith({ history: [user(1, 'question')], ...(memories === undefined ? {} : { memories }) }),
    evicted: new Set<string>(),
    recordedReferences: new Set<string>(),
    touchedPaths: files === undefined ? [] : [touchedFile('/proj/src/file.ts')],
    trusted: true,
    projectRoot: PROJECT,
    home: HOME,
    ...(observed ? { observedCapacity: true as const } : {}),
  };
  return buildContext(input, { meter: weightMeter(under), blobs: fakeBlobs(), instructions: fakeReader(files ?? {}) });
};

describe('memories are admitted against C with context.observedCapacity (4.7, readers of C; B9)', () => {
  it('has static ceilings that equal C for the two exact references', () => {
    expect(inputCeilingFor(exactAtWholeBudget)).toBe(capacityFor(estimated, nothingUnder));
    expect(inputCeilingFor(exactAtHalfBudget)).toBe(capacityFor(estimated, wholeUnder));
    expect(capacityFor(estimated, nothingUnder)).toBe(budgetFor(estimated, 0).I);
  });

  it('admits as many memories as a static ceiling equal to C would when C is above the static ceiling', async () => {
    const atStatic = await buildWith(estimated, nothingUnder, { memories: MEMORIES, observed: false });
    const atC = await buildWith(exactAtWholeBudget, nothingUnder, { memories: MEMORIES, observed: false });
    expect(atStatic.loadedMemoryIds.length).toBeLessThan(atC.loadedMemoryIds.length);

    const observed = await buildWith(estimated, nothingUnder, { memories: MEMORIES, observed: true });

    expect(observed.loadedMemoryIds).toEqual(atC.loadedMemoryIds);
  });

  it('admits as few memories as a static ceiling equal to C would when C is below the static ceiling', async () => {
    const atStatic = await buildWith(estimated, wholeUnder, { memories: MEMORIES, observed: false });
    const atC = await buildWith(exactAtHalfBudget, wholeUnder, { memories: MEMORIES, observed: false });
    expect(atC.loadedMemoryIds.length).toBeLessThan(atStatic.loadedMemoryIds.length);

    const observed = await buildWith(estimated, wholeUnder, { memories: MEMORIES, observed: true });

    expect(observed.loadedMemoryIds).toEqual(atC.loadedMemoryIds);
  });
});

describe('a nested AGENTS.md is admitted against C with context.observedCapacity (4.7, readers of C)', () => {
  const between = Math.floor((inputCeilingFor(estimated) + budgetFor(estimated, 0).I) / 2);
  const files = { [NESTED_AGENTS]: 'n'.repeat(between - floorTokens) };

  it('admits a file that fits C but not the static ceiling', async () => {
    const atStatic = await buildWith(estimated, nothingUnder, { files, observed: false });
    const atC = await buildWith(exactAtWholeBudget, nothingUnder, { files, observed: false });
    expect(atStatic.loadedInstructions.map((file) => file.path)).not.toContain(NESTED_AGENTS);
    expect(atC.loadedInstructions.map((file) => file.path)).toContain(NESTED_AGENTS);

    const observed = await buildWith(estimated, nothingUnder, { files, observed: true });

    expect(observed.loadedInstructions).toEqual(atC.loadedInstructions);
    expect(observed.notices.map((notice) => notice.code)).not.toContain('instructions_dropped');
  });
});
