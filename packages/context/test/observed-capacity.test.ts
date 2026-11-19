import { describe, expect, it } from 'vitest';
import * as contextModule from '@momonga/context';
import { ContextOverflowError, PinnedOverflowError, buildContext, budgetFor, inputCeilingFor } from '@momonga/context';
import type { BuildContextInput, HistoryItem } from '@momonga/context';
import { COMPACT_AT, ESTIMATED_ERROR, ceilRatio, floorRatio } from '@momonga/protocol';
import type { Capabilities, InputItem } from '@momonga/protocol';
import { HOME, MODEL, PROJECT, SYSTEM_PROMPT, TASK, assistant, call, capabilitiesFor, fakeBlobs, fakeReader, output, sourcesWith, user, withTurnsBeforeCurrent } from './helpers.ts';
import { weightMeter, weightOf, weightOfAll } from './weight-meter.ts';
import type { UnderRule } from './weight-meter.ts';
import { TEST_FENCE } from '@momonga/testkit';

type CapacityFor = (capabilities: Capabilities, underAt: UnderRule) => number;

const capacityFor = (capabilities: Capabilities, underAt: UnderRule): number => {
  const exported = (contextModule as unknown as { capacityFor?: CapacityFor }).capacityFor;
  if (exported === undefined) throw new Error('@momonga/context exports no capacityFor');
  return exported(capabilities, underAt);
};

type ObservedInput = BuildContextInput & { observedCapacity: true; forms?: ReadonlyMap<string, number> };

const observed = (input: BuildContextInput, forms?: ReadonlyMap<string, number>): BuildContextInput => {
  const withSetting: ObservedInput = { ...input, observedCapacity: true, ...(forms === undefined ? {} : { forms }) };
  return withSetting;
};

const baseInput = (capabilities: Capabilities, history: HistoryItem[], extra: Partial<BuildContextInput> = {}): BuildContextInput => ({ reasoningRoom: 0,
  capabilities,
  fence: TEST_FENCE,
  model: MODEL,
  sources: sourcesWith({ history }),
  evicted: new Set<string>(),
  recordedReferences: new Set<string>(),
  touchedPaths: [],
  trusted: true,
  projectRoot: PROJECT,
  home: HOME,
  ...extra,
});

const portsWith = (under?: UnderRule) => ({ meter: weightMeter(under), blobs: fakeBlobs(), instructions: fakeReader() });

const floorTokens = weightOf({ type: 'message', role: 'system', content: SYSTEM_PROMPT }) + weightOf(TASK);

describe('capacityFor, the observed capacity C (4.7, M5, B9)', () => {
  it.for([8192, 32_768, 200_000, 1_000_003])('equals inputCeilingFor with nothing reported, an estimated counter, W = %i', (window) => {
    const capabilities = capabilitiesFor(window, { tokenCounting: 'estimated' });
    expect(capacityFor(capabilities, (tokens) => ceilRatio(ESTIMATED_ERROR, tokens))).toBe(inputCeilingFor(capabilities));
  });

  it('is the whole input budget when the bound is zero at every size', () => {
    const capabilities = capabilitiesFor(8192, { tokenCounting: 'estimated' });
    expect(capacityFor(capabilities, () => 0)).toBe(budgetFor(capabilities, 0, 0).I);
  });

  it('is the largest m with m + under(m) within the input budget', () => {
    const capabilities = capabilitiesFor(8192, { maxOutputTokens: 1024 });
    const inputBudget = budgetFor(capabilities, 0, 0).I;
    expect(capacityFor(capabilities, (tokens) => tokens)).toBe(Math.floor(inputBudget / 2));
  });
});

const historyTotalling = (target: number): HistoryItem[] => {
  const withPad = (pad: number): HistoryItem[] =>
    withTurnsBeforeCurrent([user(1, 'old question'), call(2, 'c1'), output(3, 'c1', 'o'.repeat(300)), assistant(4, 'old answer'), user(5, 'p'.repeat(pad))]);
  return withPad(target - floorTokens - weightOfAll(withPad(0).map((entry) => entry.item)));
};

const estimated = capabilitiesFor(8192, { tokenCounting: 'estimated', maxOutputTokens: 1024 });
const staticHighMark = floorTokens + floorRatio(COMPACT_AT, inputCeilingFor(estimated) - floorTokens);
const observedHighMark = floorTokens + floorRatio(COMPACT_AT, budgetFor(estimated, 0, 0).I - floorTokens);

describe('the high mark reads C with context.observedCapacity (4.7, readers of C)', () => {
  it('does not evict above the static high mark while the total stays below the high mark of C', async () => {
    expect(staticHighMark + 1).toBeLessThan(observedHighMark);

    const built = await buildContext(observed(baseInput(estimated, historyTotalling(staticHighMark + 1))), portsWith(() => 0));

    expect(built.evictions).toEqual([]);
  });

  it('evicts at the static high mark without the setting', async () => {
    const built = await buildContext(baseInput(estimated, historyTotalling(staticHighMark + 1)), portsWith(() => 0));

    expect(built.evictions.map((eviction) => eviction.callId)).toEqual(['c1']);
  });
});

describe('a fall of C mid-run never raises a pinned error (4.7)', () => {
  it('fails an admitted floor that no longer fits through the context path, not PinnedOverflowError', async () => {
    const capabilities = capabilitiesFor(8192, { maxOutputTokens: 1024 });
    const inputBudget = budgetFor(capabilities, 0, 0).I;
    const history = [user(1, 'question')];

    const error = await buildContext(observed(baseInput(capabilities, history, { pinnedTokens: floorTokens })), portsWith(() => inputBudget)).catch(
      (caught: unknown) => caught,
    );

    expect(error).not.toBeInstanceOf(PinnedOverflowError);
    expect(error).toBeInstanceOf(ContextOverflowError);
  });
});

const BIG_OUTPUT = Array.from({ length: 400 }, (_, index) => `line ${String(index).padStart(3, '0')}`).join('\n');

const outputHistory = (): HistoryItem[] => [user(1, 'read it'), call(2, 'c1'), output(3, 'c1', BIG_OUTPUT), assistant(4, 'read')];

const outputItemOf = (input: readonly InputItem[]): InputItem | undefined =>
  input.find((item) => item.type === 'function_call_output' && item.call_id === 'c1');

describe('a rendered output keeps its form between named events (4.7, M6)', () => {
  it('reports the kept characters of a first truncation', async () => {
    const capabilities = capabilitiesFor(8192, { maxOutputTokens: 1024 });

    const built = await buildContext(observed(baseInput(capabilities, outputHistory())), portsWith());

    const [eviction] = built.evictions;
    expect(eviction).toMatchObject({ callId: 'c1', kind: 'truncated', keptChars: expect.any(Number) });
    const kept = (eviction as unknown as { keptChars: number }).keptChars;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(BIG_OUTPUT.length);
  });

  it('renders a recorded form byte for byte when the item cap fell without a named event', async () => {
    const capabilities = capabilitiesFor(8192, { maxOutputTokens: 1024 });
    const first = await buildContext(observed(baseInput(capabilities, outputHistory())), portsWith());
    const kept = (first.evictions[0] as { keptChars?: number }).keptChars;
    expect(kept).toEqual(expect.any(Number));

    const later = await buildContext(
      observed(baseInput(capabilities, outputHistory()), new Map([['c1', kept as number]])),
      portsWith((tokens) => 2 * tokens),
    );

    expect(outputItemOf(later.input)).toEqual(outputItemOf(first.input));
  });
});
