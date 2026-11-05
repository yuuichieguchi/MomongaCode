import { parseOutsideJson } from '@momonga/foundation';
import { asciiLower, partitionTerms } from '@momonga/protocol';

const INDENT = 2;
const LOSSY_NUMBER = /\d{16,}/;

type JsonObject = { [key: string]: unknown };

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

const leafTexts = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(leafTexts);
  if (isObject(value)) return Object.values(value).flatMap(leafTexts);
  return value === null ? [] : [asciiLower(String(value))];
};

const keysOf = (value: JsonObject): string => JSON.stringify(Object.keys(value).sort());

const shapeOf = (elements: readonly unknown[]): string | undefined => {
  const [first] = elements;
  if (isObject(first)) {
    const signature = keysOf(first);
    const same = elements.every((element) => isObject(element) && keysOf(element) === signature);
    return same ? `{${Object.keys(first).join(', ')}}` : undefined;
  }
  if (typeof first === 'string' || typeof first === 'number' || typeof first === 'boolean') {
    return elements.every((element) => typeof element === typeof first) ? typeof first : undefined;
  }
  return undefined;
};

const transformed = (value: unknown, terms: readonly string[]): unknown => {
  if (Array.isArray(value)) {
    const shape = value.length > 1 ? shapeOf(value) : undefined;
    if (shape === undefined) return value.map((element) => transformed(element, terms));
    const matching = value.filter((element) => leafTexts(element).some((text) => terms.some((term) => text.includes(term))));
    const note = `${value.length} elements, each ${shape}${matching.length === 0 ? '' : `; the ${matching.length} matching the task terms follow`}`;
    return [note, ...matching.map((element) => transformed(element, terms))];
  }
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, transformed(entry, terms)]));
  return value;
};

export const formatJson = (raw: string, terms: readonly string[]): string | undefined => {
  if (LOSSY_NUMBER.test(raw)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseOutsideJson(raw);
  } catch {
    return undefined;
  }
  const matchTerms = partitionTerms(terms.map(asciiLower)).indexed;
  return JSON.stringify(transformed(parsed, matchTerms), null, raw.includes('\n') ? INDENT : undefined);
};
