// ata-validator/lite, kept for code that already imports it; new code imports
// ata-validator, whose browser build loads the code generator on demand.
// The same Validator and one-shot functions as
// ata-validator, on the interpreted engine and without the code generator.
// Validator#parse and the static bundle methods throw a TypeError here.
export {
  Validator,
  validate,
  validateAsync,
  parseAsync,
  defineSchema,
  version,
} from './index.js';
export type * from './index.js';

export type PatternQuery = { readonly source: string; readonly flags: string; readonly input: string };
export function patternQueryKey(query: PatternQuery): string;
export function evaluateWithPatternAnswers<T>(
  answers: ReadonlyMap<string, boolean>,
  run: () => T,
): { readonly value: T; readonly queries: readonly PatternQuery[] };
