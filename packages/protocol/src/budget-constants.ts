import type { Capabilities } from './capabilities.ts';

export const MARGIN_RATIO = 0.02;
export const MIN_MARGIN = 32;
export const ESTIMATED_ERROR_BOUND_RATIO = 0.3;
export const MIN_SUMMARY_TOKENS = 64;
export const MAX_SUMMARY_TOKENS = 4096;
export const SUMMARY_WINDOW_RATIO = 0.06;
export const SUMMARY_ROOM_RATIO = 0.3;
export const SUMMARY_ACCEPT_RATIO = 1.3;
export const SUMMARY_ITEM_OVERHEAD = 20;
export const SUMMARY_PROMPT_TOKENS = 395;
export const COMPACTION_INSTRUCTIONS_VERSION = 2;
export const ESTIMATED_CHARACTERS_PER_TOKEN = 4;
export const MAX_COMPACTION_GUIDELINE_CHARS = ESTIMATED_CHARACTERS_PER_TOKEN * MIN_SUMMARY_TOKENS;
export const WORKING_STATE_SUMMARY_RATIO = 0.5;
export const MAX_JOURNAL_SEQ_DIGITS = 7;
export const RUN_ID_CHARS = 36;
export const WORKING_FACTS_KEPT = Math.ceil(WORKING_STATE_SUMMARY_RATIO * MAX_SUMMARY_TOKENS);
export const WORKING_FACT_TEXT_CHARS = ESTIMATED_CHARACTERS_PER_TOKEN * WORKING_FACTS_KEPT;

const MIN_OUTPUT_RESERVE = 256;
const OUTPUT_RESERVE_RATIO = 0.25;
const MAX_OUTPUT_WINDOW_RATIO = 0.5;

export const marginFloorFor = (contextWindow: number): number => Math.max(Math.ceil(MARGIN_RATIO * contextWindow), MIN_MARGIN);

export const outputReserveFor = (capabilities: Capabilities): number =>
  Math.min(
    capabilities.maxOutputTokens,
    Math.max(MIN_OUTPUT_RESERVE, Math.ceil(OUTPUT_RESERVE_RATIO * capabilities.contextWindow)),
    Math.floor(MAX_OUTPUT_WINDOW_RATIO * capabilities.contextWindow),
  );

export const summaryTokenCapFor = (capabilities: Capabilities, room?: number): number => {
  const base = Math.min(
    MAX_SUMMARY_TOKENS,
    Math.max(MIN_SUMMARY_TOKENS, Math.ceil(SUMMARY_WINDOW_RATIO * capabilities.contextWindow)),
  );
  return room === undefined ? base : Math.max(MIN_SUMMARY_TOKENS, Math.min(base, Math.floor(SUMMARY_ROOM_RATIO * room)));
};

export const summaryItemTokensFor = (cap: number): number => Math.ceil(SUMMARY_ACCEPT_RATIO * cap) + SUMMARY_ITEM_OVERHEAD;

export const sizingRatioFor = (capabilities: Capabilities): number =>
  capabilities.tokenErrorRatio ?? (capabilities.tokenCounting === 'exact' ? 0 : ESTIMATED_ERROR_BOUND_RATIO);
