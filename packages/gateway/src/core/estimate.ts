import { canonicalJson } from '@momonga/foundation';
import { ESTIMATED_ERROR_BOUND_RATIO } from '@momonga/protocol';
import type { AdapterInputItem, FunctionTool, ItemField, Usage } from '@momonga/protocol';
import { withoutImages } from './image-tokens.ts';

const CHARS_PER_TOKEN = 4;

export const tokensForText = (text: string): number => Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));

export type EstimateInput = {
  input: readonly AdapterInputItem[];
  instructions?: string | null | undefined;
  tools?: readonly FunctionTool[] | undefined;
};

export const estimateInputTokens = (request: EstimateInput): number => {
  const { value, imageTokens } = withoutImages([request.instructions ?? null, request.tools ?? [], request.input]);
  return tokensForText(canonicalJson(value)) + imageTokens;
};

export const imageTokensOfWire = (wire: unknown): number => withoutImages(wire).imageTokens;

export const wireTokensOf = (wire: unknown): number => {
  const { value, imageTokens } = withoutImages(wire);
  return tokensForText(JSON.stringify(value)) + imageTokens;
};

export const errorBoundFor = (tokens: number): number => Math.max(1, Math.ceil(tokens * ESTIMATED_ERROR_BOUND_RATIO));

export const estimateOutputTokens = (output: readonly ItemField[]): number => tokensForText(canonicalJson(output));

export const estimatedUsage = (inputTokens: number, outputTokens: number): Usage => ({
  input_tokens: inputTokens,
  output_tokens: outputTokens,
  total_tokens: inputTokens + outputTokens,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
});
