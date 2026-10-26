import { describe, expect, it } from 'vitest';
import {
  MIN_ROOM_TOKENS,
  PinnedOverflowError,
  PinnedRoomError,
  buildContext,
  inputCeilingFor,
  itemCapFor,
  measurePinned,
} from '@momonga/context';
import type { InputItem } from '@momonga/protocol';
import {
  READ_TOOL,
  ROOT_AGENTS,
  TASK,
  call,
  capabilitiesFor,
  harness,
  inputFor,
  output,
  sourcesWith,
  tokensOfItem,
  tokensOfTools,
  truncatedMarker,
  outputTextOf,
} from './helpers.ts';

const W4096 = (overrides: Parameters<typeof capabilitiesFor>[1] = {}) => capabilitiesFor(4096, { maxOutputTokens: 1024, ...overrides });

describe('the sizing ratio fixed by the pins', () => {
  it.for([
    { label: 'estimated without a ratio', overrides: { tokenCounting: 'estimated' as const }, ceiling: 2300 },
    { label: 'calibrated without a ratio', overrides: { tokenCounting: 'calibrated' as const }, ceiling: 2300 },
    { label: 'exact without a ratio', overrides: { tokenCounting: 'exact' as const }, ceiling: 2990 },
    { label: 'calibrated with ratio 0.1', overrides: { tokenCounting: 'calibrated' as const, tokenErrorRatio: 0.1 }, ceiling: 2718 },
    { label: 'estimated with ratio 0', overrides: { tokenCounting: 'estimated' as const, tokenErrorRatio: 0 }, ceiling: 2990 },
  ])('gives the ceiling $ceiling for $label', ({ overrides, ceiling }) => {
    expect(inputCeilingFor(W4096(overrides))).toBe(ceiling);
  });
});

describe('itemCapFor with the room above the pinned floor', () => {
  it.for([
    [379, 189],
    [1219, 609],
    [632, 316],
    [100, 64],
    [5000, 747],
  ] as const)('a room of %i tokens gives an item cap of %i', ([room, cap]) => {
    expect(itemCapFor(W4096({ tokenCounting: 'estimated' }), room)).toBe(cap);
  });
});

describe('PinnedOverflowError names the ceiling and the breakdown', () => {
  it('reports the fixed prefix by part when it exceeds the ceiling', async () => {
    const capabilities = capabilitiesFor(1024);
    const sources = sourcesWith({ systemPrompt: 's'.repeat(4000), tools: [READ_TOOL] });
    const error = await buildContext(inputFor(capabilities, { sources }), harness(capabilities).ports).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PinnedOverflowError);
    const pinned = error as PinnedOverflowError;
    const systemTokens = tokensOfItem({ type: 'message', role: 'system', content: 's'.repeat(4000) });
    expect(pinned.ceiling).toBe(736);
    expect(pinned.pinnedTokens).toBe(systemTokens + tokensOfTools([READ_TOOL]) + tokensOfItem(TASK));
    expect(pinned.breakdown).toEqual({ systemPrompt: systemTokens, tools: tokensOfTools([READ_TOOL]), instructions: 0, task: tokensOfItem(TASK) });
  });
});

describe('minimum room above the pinned prefix', () => {
  const capabilities = capabilitiesFor(1024);

  it('is 192 tokens', () => {
    expect(MIN_ROOM_TOKENS).toBe(192);
  });

  it('fails with the minimum-room subtype when the prefix fits but leaves 191 tokens', async () => {
    const error = await buildContext(inputFor(capabilities, { sources: sourcesWith({ systemPrompt: 's'.repeat(2070) }) }), harness(capabilities).ports).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PinnedRoomError);
    expect(error).toBeInstanceOf(PinnedOverflowError);
    const room = error as PinnedRoomError;
    expect(room.pinnedTokens).toBe(545);
    expect(room.ceiling).toBe(736);
    expect(room.room).toBe(191);
    expect(room.minimum).toBe(192);
  });

  it('builds when exactly 192 tokens remain', async () => {
    const built = await buildContext(inputFor(capabilities, { sources: sourcesWith({ systemPrompt: 's'.repeat(2066) }) }), harness(capabilities).ports);
    expect(built.inputTokens).toBe(544);
  });

  it('fails measurePinned with the same subtype', async () => {
    const error = await measurePinned(inputFor(capabilities, { sources: sourcesWith({ systemPrompt: 's'.repeat(2070) }) }), harness(capabilities).ports).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PinnedRoomError);
  });
});

describe('measurePinned', () => {
  const capabilities = capabilitiesFor(4000);
  const systemPrompt = 's'.repeat(6000);
  const bigOutputHistory = [call(1, 'big'), output(2, 'big', 'r'.repeat(4000))];

  const expectedFor = (pinnedTokens: number) => {
    const room = 2920 - pinnedTokens;
    return {
      pinnedTokens,
      ceiling: 2920,
      room,
      itemCap: Math.max(64, Math.min(730, Math.floor(0.5 * room))),
      summaryCap: Math.max(64, Math.min(240, Math.floor(0.3 * room))),
    };
  };

  it('measures the system prompt and task as the pinned floor', async () => {
    const measured = await measurePinned(inputFor(capabilities, { sources: sourcesWith({ systemPrompt }) }), harness(capabilities).ports);
    const systemTokens = tokensOfItem({ type: 'message', role: 'system', content: systemPrompt });
    expect(systemTokens).toBe(1512);
    expect(measured).toEqual(expectedFor(1512 + tokensOfItem(TASK)));
  });

  it('lowers the room and the item cap consistently for a root AGENTS.md, and the builder truncates to that cap', async () => {
    const files = { [ROOT_AGENTS]: 'r'.repeat(680) };
    const input = inputFor(capabilities, { sources: sourcesWith({ systemPrompt, history: bigOutputHistory }) });
    const measured = await measurePinned(input, harness(capabilities, { files }).ports);
    const built = await buildContext(input, harness(capabilities, { files }).ports);
    const rootMessage = built.input.find((item): item is Extract<InputItem, { type: 'message' }> => item.type === 'message' && item.role === 'developer');
    if (rootMessage === undefined) throw new Error('expected the root instructions message');

    const without = await measurePinned(inputFor(capabilities, { sources: sourcesWith({ systemPrompt }) }), harness(capabilities).ports);
    expect(measured).toEqual(expectedFor(without.pinnedTokens + tokensOfItem(rootMessage)));
    expect(measured.itemCap).toBeLessThan(without.itemCap);

    const rendered = built.input.find((item) => item.type === 'function_call_output');
    expect(truncatedMarker.exec(outputTextOf(built.input, 'big') ?? '')).not.toBeNull();
    expect(tokensOfItem(rendered as InputItem)).toBeLessThanOrEqual(measured.itemCap);
  });

  it('uses an item cap passed by the caller instead of measuring one', async () => {
    const built = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ systemPrompt, history: bigOutputHistory }), itemCap: 200 }),
      harness(capabilities).ports,
    );
    const rendered = built.input.find((item) => item.type === 'function_call_output');
    expect(tokensOfItem(rendered as InputItem)).toBeLessThanOrEqual(200);
    expect(tokensOfItem(rendered as InputItem)).toBeGreaterThan(150);
  });
});
