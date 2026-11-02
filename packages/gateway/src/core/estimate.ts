import { canonicalJson } from '@momonga/foundation';
import { ESTIMATED_ERROR_BOUND_RATIO } from '@momonga/protocol';
import type { AdapterInputItem, FunctionTool, ImageTokenModel, ItemField, Usage } from '@momonga/protocol';
import { withoutImages } from './image-tokens.ts';

const NARROW_UNITS_PER_TOKEN = 4;
const ALPHABETIC_CHARACTERS_PER_TOKEN = 2;
const ALPHABETIC_CHARACTER = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}]/u;
const NARROW_CHARACTER = /[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const PER_CHARACTER_EXCEPTION = /\p{Extended_Pictographic}|[\u3000-\u303F\uFF00-\uFFEF]/u;
const FIRST_NON_ASCII = 0x80;
const FIRST_ASTRAL = 0x10000;

type ScriptClass = 'narrow' | 'alphabetic' | 'per_character';

const scriptClassOf = (codePoint: number): ScriptClass => {
  if (codePoint < FIRST_NON_ASCII) return 'narrow';
  const character = String.fromCodePoint(codePoint);
  if (PER_CHARACTER_EXCEPTION.test(character)) return 'per_character';
  if (NARROW_CHARACTER.test(character)) return 'narrow';
  return ALPHABETIC_CHARACTER.test(character) ? 'alphabetic' : 'per_character';
};

export const tokensForText = (text: string): number => {
  let narrowUnits = 0;
  let alphabeticCharacters = 0;
  let perCharacter = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) as number;
    const units = codePoint >= FIRST_ASTRAL ? 2 : 1;
    const scriptClass = scriptClassOf(codePoint);
    if (scriptClass === 'narrow') narrowUnits += units;
    else if (scriptClass === 'alphabetic') alphabeticCharacters += 1;
    else perCharacter += 1;
    index += units;
  }
  return Math.max(
    1,
    Math.ceil(narrowUnits / NARROW_UNITS_PER_TOKEN) + Math.ceil(alphabeticCharacters / ALPHABETIC_CHARACTERS_PER_TOKEN) + perCharacter,
  );
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
