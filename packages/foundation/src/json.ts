import { JsonDepthError, MAX_JSON_DEPTH, parseOutsideJson } from './json-depth.ts';

export type BoundedJson = { kind: 'value'; value: unknown } | { kind: 'text'; text: string; reason: 'malformed' | 'too_deep' };

export const parseBoundedJson = (text: string, parse: (text: string) => unknown = parseOutsideJson): BoundedJson => {
  try {
    return { kind: 'value', value: parse(text) };
  } catch (error) {
    if (error instanceof JsonDepthError) return { kind: 'text', text, reason: 'too_deep' };
    if (error instanceof SyntaxError) return { kind: 'text', text, reason: 'malformed' };
    throw error;
  }
};

export const TOO_DEEP_PLACEHOLDER = `[arguments nest deeper than ${MAX_JSON_DEPTH} levels]`;

export const spanValueOfJsonText = (text: string): unknown => {
  const parsed = parseBoundedJson(text);
  if (parsed.kind === 'value') return parsed.value;
  return parsed.reason === 'too_deep' ? TOO_DEEP_PLACEHOLDER : parsed.text;
};

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
