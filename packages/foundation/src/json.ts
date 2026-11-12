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

export type JsonTextKind = 'arguments' | 'tool output' | 'text';

const TOO_DEEP_PLACEHOLDERS: Readonly<Record<JsonTextKind, string>> = {
  arguments: `[arguments nest deeper than ${MAX_JSON_DEPTH} levels]`,
  'tool output': `[tool output nests deeper than ${MAX_JSON_DEPTH} levels]`,
  text: `[text nests deeper than ${MAX_JSON_DEPTH} levels]`,
};

export const spanValueOfJsonText = (text: string, kind: JsonTextKind): unknown => {
  const parsed = parseBoundedJson(text);
  if (parsed.kind === 'value') return parsed.value;
  return parsed.reason === 'too_deep' ? TOO_DEEP_PLACEHOLDERS[kind] : parsed.text;
};

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseShippedManifest = (text: string, manifest: string, failure: (message: string) => Error): unknown => {
  const bounded = parseBoundedJson(text);
  if (bounded.kind === 'value') return bounded.value;
  const why = bounded.reason === 'too_deep' ? 'nests deeper than the bound of a JSON value' : 'is not valid JSON';
  throw failure(`the manifest ${manifest} ${why}: reinstall momonga`);
};
