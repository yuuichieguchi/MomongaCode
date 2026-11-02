import { canonicalJson } from '@momonga/foundation';
import { ESTIMATED_ERROR_BOUND_RATIO } from '@momonga/protocol';
import type { AdapterInputItem, FunctionTool, ImageTokenModel, ItemField, Usage } from '@momonga/protocol';
import { withoutImages } from './image-tokens.ts';

const NARROW_UNITS_PER_TOKEN = 4;
const WIDE_CHARACTER = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]|\p{Extended_Pictographic}|[\u3000-\u303F\uFF00-\uFFEF]/u;
const FIRST_NON_ASCII = 0x80;
const FIRST_ASTRAL = 0x10000;

export const tokensForText = (text: string): number => {
  let narrowUnits = 0;
  let wideCharacters = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) as number;
    const units = codePoint >= FIRST_ASTRAL ? 2 : 1;
    if (codePoint < FIRST_NON_ASCII || !WIDE_CHARACTER.test(String.fromCodePoint(codePoint))) narrowUnits += units;
    else wideCharacters += 1;
    index += units;
  }
  return Math.max(1, Math.ceil(narrowUnits / NARROW_UNITS_PER_TOKEN) + wideCharacters);
};

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
