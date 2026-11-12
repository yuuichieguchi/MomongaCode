import { safeSlice } from './text-slice.ts';

export const REDACTED_MARKER ='[REDACTED]';
export const MIN_CREDENTIAL_CHARS = 8;
export const MAX_REDACTED_CHARS = 1024;
const TRUNCATION_SUFFIX = ' …[truncated]';

export type Redactor = {
  text(input: string): string;
  whole(input: string): string;
  add(credential: string): void;
  set(key: string, values: readonly string[]): void;
};

export type RedactorOptions = {
  credentials: readonly string[];
};

const MASKED_CREDENTIAL =
  /(?<![A-Za-z0-9_*•-])(?:(?:sk-|AIza|gsk_|xai-|hf_|pplx-|nvapi-)[A-Za-z0-9_-]*(?:(?:[*•.…]{3,}|…)[A-Za-z0-9_-]*)+|[A-Za-z0-9_-]+(?:(?=[*•]{4})[*•.…]+[A-Za-z0-9_-]*)+|(?:(?=[*•]{4})[*•.…]+[A-Za-z0-9_-]+)+)/g;
const SK_KEY = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/g;
const GOOGLE_KEY = /AIza[0-9A-Za-z_-]{35}/g;
const PROVIDER_KEY = /(?<![A-Za-z0-9])(?:gsk_|xai-|hf_|pplx-|nvapi-)[A-Za-z0-9_-]{20,}/g;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)(\s{1,8})([A-Za-z0-9._~+/=-]{16,})/gi;
const CREDENTIAL_FIELD =
  /\b(api[_-]?key|x-api-key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|secret|token|password|passwd|key)\b((?:\\*["'])?\s{0,8}[:=]\s{0,8}(?:\\*["'])?)([A-Za-z0-9._~+/=-]{16,})/gi;

const variantsOf = (value: string): string[] => {
  const trimmed = value.trim();
  if (trimmed.length < MIN_CREDENTIAL_CHARS) return [];
  return [value, trimmed].flatMap((base) => [base, JSON.stringify(base).slice(1, -1), encodeURIComponent(base), Buffer.from(base, 'utf8').toString('base64')]);
};

const exactValuesOf = (credentials: readonly string[]): string[] =>
  [...new Set(credentials.flatMap(variantsOf))].sort((left, right) => right.length - left.length);

const capped = (input: string): string => {
  if (input.length <= MAX_REDACTED_CHARS) return input;
  return safeSlice(input, 0, MAX_REDACTED_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
};

export const createRedactor = (options: RedactorOptions): Redactor => {
  const fixed = new Set<string>(options.credentials);
  const keyed = new Map<string, readonly string[]>();
  const heldValues = (): string[] => [...fixed, ...[...keyed.values()].flat()];
  let exactValues = exactValuesOf(heldValues());
  const rebuild = (): void => {
    exactValues = exactValuesOf(heldValues());
  };
  const add = (credential: string): void => {
    if (fixed.has(credential)) return;
    fixed.add(credential);
    rebuild();
  };
  const sameList = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);
  const set = (key: string, values: readonly string[]): void => {
    if (sameList(keyed.get(key) ?? [], values)) return;
    if (values.length === 0) keyed.delete(key);
    else keyed.set(key, [...values]);
    rebuild();
  };
  const whole = (input: string): string => {
    let output = input;
    for (const value of exactValues) output = output.split(value).join(REDACTED_MARKER);
    output = output.replace(MASKED_CREDENTIAL, REDACTED_MARKER);
    output = output.replace(SK_KEY, REDACTED_MARKER);
    output = output.replace(GOOGLE_KEY, REDACTED_MARKER);
    output = output.replace(PROVIDER_KEY, REDACTED_MARKER);
    output = output.replace(AUTHORIZATION_VALUE, (_match, scheme: string) => `${scheme} ${REDACTED_MARKER}`);
    output = output.replace(CREDENTIAL_FIELD, (_match, name: string, separator: string) => `${name}${separator}${REDACTED_MARKER}`);
    return output;
  };
  const text = (input: string): string => capped(whole(input));
  return { text, whole, add, set };
};
