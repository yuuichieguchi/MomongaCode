import { canonicalJson } from '@momonga/foundation';
import { ESTIMATED_ERROR_SHAPE, countReplyOf, errorBoundOfShape, tokensForText } from '@momonga/protocol';
import type { AdapterInputItem, CountTokensResult, FunctionTool, ImageTokenModel, ItemField, Usage } from '@momonga/protocol';
import { withoutImages } from './image-tokens.ts';
import { promptPartsOf } from './prompt-parts.ts';

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

export const wireTokensOf = (wire: Readonly<Record<string, unknown>>, imageModel?: ImageTokenModel): number => {
  const { value, imageTokens } = withoutImages(promptPartsOf(wire), imageModel);
  return tokensForText(JSON.stringify(value)) + imageTokens;
};

export const errorBoundFor = (tokens: number): number => errorBoundOfShape(ESTIMATED_ERROR_SHAPE, tokens);

export const estimatedCountOf = (tokens: number): CountTokensResult => countReplyOf(tokens, 'estimated', ESTIMATED_ERROR_SHAPE);

export const estimateOutputTokens = (output: readonly ItemField[]): number => tokensForText(canonicalJson(output));

export const estimatedUsage = (inputTokens: number, outputTokens: number): Usage => ({
  input_tokens: inputTokens,
  output_tokens: outputTokens,
  total_tokens: inputTokens + outputTokens,
  input_tokens_details: {},
  output_tokens_details: { reasoning_tokens: 0 },
});
