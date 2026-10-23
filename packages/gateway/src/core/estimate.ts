import { canonicalJson } from '@momonga/foundation';
import type { AdapterInputItem, FunctionTool, ItemField, Usage } from '@momonga/protocol';

const CHARS_PER_TOKEN = 4;
const ERROR_BOUND_RATIO = 0.3;

const tokensForText = (text: string): number => Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));

export type EstimateInput = {
  input: readonly AdapterInputItem[];
  instructions?: string | null | undefined;
  tools?: readonly FunctionTool[] | undefined;
};

export const estimateInputTokens = (request: EstimateInput): number =>
  tokensForText(canonicalJson([request.instructions ?? null, request.tools ?? [], request.input]));

export const errorBoundFor = (tokens: number): number => Math.max(1, Math.ceil(tokens * ERROR_BOUND_RATIO));

export const estimateOutputTokens = (output: readonly ItemField[]): number => tokensForText(canonicalJson(output));

export const estimatedUsage = (inputTokens: number, outputTokens: number): Usage => ({
  input_tokens: inputTokens,
  output_tokens: outputTokens,
  total_tokens: inputTokens + outputTokens,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
});
