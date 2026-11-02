import { canonicalJson } from '@momonga/foundation';
import { ESTIMATED_ERROR_BOUND_RATIO, tokensForText } from '@momonga/protocol';
import type { AdapterInputItem, FunctionTool, ImageTokenModel, ItemField, Usage } from '@momonga/protocol';
import { withoutImages } from './image-tokens.ts';

export { tokensForText };

export type EstimateInput = {
  input: readonly AdapterInputItem[];
  instructions?: string | null | undefined;
  tools?: readonly FunctionTool[] | undefined;
};

export const estimateInputTokens = (request: EstimateInput, imageModel?: ImageTokenModel): number => {
  const { value, imageTokens } = withoutImages([request.instructions ?? null, request.tools ?? [], request.input], imageModel);
  return tokensForText(canonicalJson(value)) + imageTokens;
};

export const imageTokensOfWire = (wire: unknown, imageModel?: ImageTokenModel): number => withoutImages(wire, imageModel).imageTokens;

export const wireTokensOf = (wire: unknown, imageModel?: ImageTokenModel): number => {
  const { value, imageTokens } = withoutImages(wire, imageModel);
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
