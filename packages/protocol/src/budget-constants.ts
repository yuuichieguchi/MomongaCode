import {
  ESTIMATED_ERROR,
  MARGIN,
  MAX_OUTPUT_WINDOW,
  OUTPUT_RESERVE,
  SUMMARY_ACCEPT,
  SUMMARY_ROOM,
  SUMMARY_WINDOW,
  ceilRatio,
  floorRatio,
  quantizedRatioOf,
} from './budget-ratios.ts';
import type { Ratio } from './budget-ratios.ts';
import { LOWEST_REASONING_EFFORT, outputTokensFor } from './capabilities.ts';
import type { Capabilities } from './capabilities.ts';
import { ESTIMATED_CHARACTERS_PER_TOKEN } from './characters-per-token.ts';
import { compactionSummaryMessage } from './compaction-summary.ts';
import { FENCE_BOUNDARY_LENGTH } from './user-content.ts';
import { tokensForText } from './estimate-tokens.ts';
import type { CountTokensMethod, CountTokensResult } from './gateway-api.ts';

export const MARGIN_RATIO = MARGIN.num / MARGIN.den;
export const SUMMARY_WINDOW_RATIO = SUMMARY_WINDOW.num / SUMMARY_WINDOW.den;
export const SUMMARY_ROOM_RATIO = SUMMARY_ROOM.num / SUMMARY_ROOM.den;
export const SUMMARY_ACCEPT_RATIO = SUMMARY_ACCEPT.num / SUMMARY_ACCEPT.den;
export const MIN_MARGIN = 32;
export const ESTIMATED_ERROR_BOUND_RATIO = ESTIMATED_ERROR.num / ESTIMATED_ERROR.den;
export const MIN_SUMMARY_TOKENS = 64;
export const MAX_SUMMARY_TOKENS = 4096;
const SUMMARY_BOUNDARY_WIDTH = '0'.repeat(FENCE_BOUNDARY_LENGTH);
export const SUMMARY_ITEM_OVERHEAD = Math.max(
  tokensForText(String(compactionSummaryMessage('', 'model', SUMMARY_BOUNDARY_WIDTH).content)),
  tokensForText(String(compactionSummaryMessage('', 'code', SUMMARY_BOUNDARY_WIDTH).content)),
);
export const SUMMARY_PROMPT_TOKENS = 484;
export const SUMMARY_FOCUS_LABEL = 'The user asked for this focus in the note. Give it the most room; the rules above still hold.';
export const summaryFocusBlockOf = (focus: string): string => `\n\n${SUMMARY_FOCUS_LABEL}\n${focus}`;
export const summaryPromptTokensFor = (focus: string | undefined): number =>
  focus === undefined ? SUMMARY_PROMPT_TOKENS : SUMMARY_PROMPT_TOKENS + tokensForText(summaryFocusBlockOf(focus));
export const COMPACTION_INSTRUCTIONS_VERSION = 4;
export { ESTIMATED_CHARACTERS_PER_TOKEN };
export const MAX_COMPACTION_GUIDELINE_CHARS = ESTIMATED_CHARACTERS_PER_TOKEN * MIN_SUMMARY_TOKENS;
export const WORKING_STATE_SUMMARY_RATIO = 0.5;
export const MAX_JOURNAL_SEQ_DIGITS = 7;
export const RUN_ID_CHARS = 36;
export const WORKING_FACTS_KEPT = Math.ceil(WORKING_STATE_SUMMARY_RATIO * MAX_SUMMARY_TOKENS);
export const WORKING_FACT_TEXT_CHARS = ESTIMATED_CHARACTERS_PER_TOKEN * WORKING_FACTS_KEPT;

export const MIN_OUTPUT_RESERVE = 256;

export type ErrorShape = { readonly ratio: number; readonly minimum: number };

export const EXACT_ERROR_SHAPE: ErrorShape = { ratio: 0, minimum: 0 };

export const ESTIMATED_ERROR_SHAPE: ErrorShape = { ratio: ESTIMATED_ERROR_BOUND_RATIO, minimum: 1 };

export const errorBoundOfShape = (shape: ErrorShape, tokens: number): number => Math.max(shape.minimum, Math.ceil(shape.ratio * tokens));

export const countReplyOf = (tokens: number, method: CountTokensMethod, shape: ErrorShape): CountTokensResult => ({
  input_tokens: tokens,
  method,
  error_bound: errorBoundOfShape(shape, tokens),
  error_shape: shape,
});

export const marginFloorFor = (contextWindow: number): number => Math.max(ceilRatio(MARGIN, contextWindow), MIN_MARGIN);

export const outputReserveFor = (capabilities: Pick<Capabilities, 'contextWindow' | 'maxOutputTokens'>): number =>
  Math.min(
    capabilities.maxOutputTokens,
    Math.max(MIN_OUTPUT_RESERVE, ceilRatio(OUTPUT_RESERVE, capabilities.contextWindow)),
    floorRatio(MAX_OUTPUT_WINDOW, capabilities.contextWindow),
  );

export const summaryInputLimitFor = (
  capabilities: Pick<Capabilities, 'contextWindow' | 'maxOutputTokens'>,
  summaryCap: number,
  reasoningHeadroom: number,
): number =>
  Math.min(
    capabilities.contextWindow - summaryCap - reasoningHeadroom - marginFloorFor(capabilities.contextWindow),
    capabilities.contextWindow - outputReserveFor(capabilities),
  );

export const reasoningHeadroomFor = (capabilities: Capabilities, summaryCap: number): number =>
  outputTokensFor(capabilities, LOWEST_REASONING_EFFORT, summaryCap) - summaryCap;

export const summaryRequestInputLimitFor = (capabilities: Capabilities, summaryCap: number): number =>
  summaryInputLimitFor(capabilities, summaryCap, reasoningHeadroomFor(capabilities, summaryCap));

export const summaryTokenCapFor = (capabilities: Pick<Capabilities, 'contextWindow'>, room?: number): number => {
  const base = Math.min(
    MAX_SUMMARY_TOKENS,
    Math.max(MIN_SUMMARY_TOKENS, ceilRatio(SUMMARY_WINDOW, capabilities.contextWindow)),
  );
  return room === undefined ? base : Math.max(MIN_SUMMARY_TOKENS, Math.min(base, floorRatio(SUMMARY_ROOM, room)));
};

export const largestSummaryCapFor = (capabilities: Pick<Capabilities, 'contextWindow' | 'maxOutputTokens'>): number =>
  Math.min(summaryTokenCapFor(capabilities), capabilities.maxOutputTokens);

export const summaryItemTokensFor = (cap: number): number => ceilRatio(SUMMARY_ACCEPT, cap) + SUMMARY_ITEM_OVERHEAD;

export const sizingRatioFor = (capabilities: Capabilities): number =>
  capabilities.tokenErrorRatio ?? (capabilities.tokenCounting === 'exact' ? 0 : ESTIMATED_ERROR_BOUND_RATIO);

export const sizingFractionFor = (capabilities: Capabilities): Ratio =>
  capabilities.tokenErrorRatio !== undefined
    ? quantizedRatioOf(capabilities.tokenErrorRatio)
    : capabilities.tokenCounting === 'exact'
      ? { num: 0, den: 1 }
      : ESTIMATED_ERROR;
