import { describe, expect, it } from 'vitest';
import {
  ADAPTER_NEUTRAL_ERROR_CODES,
  COMPACTION_INSTRUCTIONS_VERSION,
  ESTIMATED_ERROR_BOUND_RATIO,
  MARGIN_RATIO,
  MAX_SUMMARY_TOKENS,
  MIN_MARGIN,
  MIN_SUMMARY_TOKENS,
  SUMMARY_ACCEPT_RATIO,
  SUMMARY_ITEM_OVERHEAD,
  SUMMARY_PROMPT_TOKENS,
  SUMMARY_ROOM_RATIO,
  SUMMARY_WINDOW_RATIO,
  marginFloorFor,
  summaryItemTokensFor,
  summaryTokenCapFor,
} from '@momonga/protocol';
import type { Capabilities, CompactRequest } from '@momonga/protocol';

const capabilitiesOf = (contextWindow: number): Capabilities => ({
  contextWindow,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: false,
  imageInput: false,
  parallelToolCalls: true,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 1,
  source: 'config',
});

describe('budget constants shared through the protocol', () => {
  it('fixes the margin, error-bound and summary ratios of the design', () => {
    expect(MARGIN_RATIO).toBe(0.02);
    expect(MIN_MARGIN).toBe(32);
    expect(ESTIMATED_ERROR_BOUND_RATIO).toBe(0.3);
    expect(MIN_SUMMARY_TOKENS).toBe(64);
    expect(MAX_SUMMARY_TOKENS).toBe(4096);
    expect(SUMMARY_WINDOW_RATIO).toBe(0.06);
    expect(SUMMARY_ROOM_RATIO).toBe(0.3);
    expect(SUMMARY_ACCEPT_RATIO).toBe(1.3);
    expect(COMPACTION_INSTRUCTIONS_VERSION).toBe(1);
  });

  it('pins the measured summary prompt and item overhead', () => {
    expect(SUMMARY_PROMPT_TOKENS).toBe(234);
    expect(SUMMARY_ITEM_OVERHEAD).toBe(20);
  });

  it.for([
    [1024, 32],
    [4096, 82],
    [32768, 656],
    [200000, 4000],
  ] as const)('marginFloorFor(%i) is %i', ([window, floor]) => {
    expect(marginFloorFor(window)).toBe(floor);
  });
});

describe('summaryTokenCapFor', () => {
  it.for([
    [1024, 64],
    [4096, 246],
    [32768, 1967],
    [200000, 4096],
  ] as const)('derives the window cap of a %i-token window as %i', ([window, cap]) => {
    expect(summaryTokenCapFor(capabilitiesOf(window))).toBe(cap);
  });

  it.for([
    [4096, 370, 111],
    [4096, 1000, 246],
    [4096, 100, 64],
    [1024, 0, 64],
  ] as const)('bounds a %i-token window with room %i to %i', ([window, room, cap]) => {
    expect(summaryTokenCapFor(capabilitiesOf(window), room)).toBe(cap);
  });
});

describe('summaryItemTokensFor', () => {
  it.for([
    [64, 84 + 20],
    [100, 130 + 20],
    [246, 320 + 20],
  ] as const)('budgets cap %i as %i tokens: the 1.3x acceptance bound plus the item overhead', ([cap, tokens]) => {
    expect(summaryItemTokensFor(cap)).toBe(tokens);
    expect(summaryItemTokensFor(cap)).toBe(Math.ceil(SUMMARY_ACCEPT_RATIO * cap) + SUMMARY_ITEM_OVERHEAD);
  });
});

describe('neutral adapter error codes', () => {
  it('treats the two compaction content outcomes as neutral for the breaker', () => {
    expect([...ADAPTER_NEUTRAL_ERROR_CODES]).toEqual([
      'guardrail_violation',
      'content_filter',
      'refusal',
      'compaction_summary_too_long',
      'compaction_invalid_reply',
    ]);
  });
});

describe('request extensions', () => {
  it('lets a compact request carry the momonga object', () => {
    const request: CompactRequest = {
      model: 'fast',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      momonga: { max_summary_tokens: MIN_SUMMARY_TOKENS, retains_user_request: true },
    };
    expect(request.momonga).toEqual({ max_summary_tokens: 64, retains_user_request: true });
  });
});
