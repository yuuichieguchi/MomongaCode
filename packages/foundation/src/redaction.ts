import { safeSlice } from './text-slice.ts';

export const REDACTED_MARKER ='[REDACTED]';
export const MIN_CREDENTIAL_CHARS = 8;
export const MAX_REDACTED_CHARS = 1024;
const TRUNCATION_SUFFIX = ' …[truncated]';

export type Redactor = {
  text(input: string): string;
  whole(input: string): string;
  add(credential: string): void;
};

export type RedactorOptions = {
  credentials: readonly string[];
};

const MASKED_CREDENTIAL =
  /(?<![A-Za-z0-9_*•-])(?:(?:sk-|AIza|gsk_|xai-|hf_|pplx-|nvapi-)[A-Za-z0-9_-]*(?:(?:[*•.…]{3,}|…)[A-Za-z0-9_-]*)+|[A-Za-z0-9_-]*(?:[*•]{3,}[*•.…]*[A-Za-z0-9_-]*)+)/g;
const SK_KEY = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/g;
const GOOGLE_KEY = /AIza[0-9A-Za-z_-]{35}/g;
const PROVIDER_KEY = /(?<![A-Za-z0-9])(?:gsk_|xai-|hf_|pplx-|nvapi-)[A-Za-z0-9_-]{20,}/g;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)(\s{1,8})([A-Za-z0-9._~+/=-]{16,})/gi;
const CREDENTIAL_FIELD =
  /\b(api[_-]?key|x-api-key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|secret|token|password|passwd|key)\b(["']?\s{0,8}[:=]\s{0,8}["']?)([A-Za-z0-9._~+/=-]{16,})/gi;

const HAS_DIGIT = /\d/;
const HAS_LETTER = /[A-Za-z]/;

const variantsOf = (value: string): string[] => {
  const trimmed = value.trim();
  if (trimmed.length < MIN_CREDENTIAL_CHARS) return [];
  return [value, trimmed].flatMap((base) => [base, JSON.stringify(base).slice(1, -1), encodeURIComponent(base)]);
};

const exactValuesOf = (credentials: readonly string[]): string[] =>
  [...new Set(credentials.flatMap(variantsOf))].sort((left, right) => right.length - left.length);

const capped = (input: string): string => {
  if (input.length <= MAX_REDACTED_CHARS) return input;
  return safeSlice(input, 0, MAX_REDACTED_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
};

export const createRedactor = (options: RedactorOptions): Redactor => {
  const credentials = [...options.credentials];
  let exactValues = exactValuesOf(credentials);
  const add = (credential: string): void => {
    credentials.push(credential);
    exactValues = exactValuesOf(credentials);
  };
  const whole = (input: string): string => {
    let output = input;
    for (const value of exactValues) output = output.split(value).join(REDACTED_MARKER);
    output = output.replace(MASKED_CREDENTIAL, REDACTED_MARKER);
    output = output.replace(SK_KEY, REDACTED_MARKER);
    output = output.replace(GOOGLE_KEY, REDACTED_MARKER);
    output = output.replace(PROVIDER_KEY, REDACTED_MARKER);
    output = output.replace(AUTHORIZATION_VALUE, (match, scheme: string, _space: string, token: string) =>
      HAS_DIGIT.test(token) ? `${scheme} ${REDACTED_MARKER}` : match,
    );
    output = output.replace(CREDENTIAL_FIELD, (match, name: string, separator: string, value: string) =>
      HAS_DIGIT.test(value) && HAS_LETTER.test(value) ? `${name}${separator}${REDACTED_MARKER}` : match,
    );
    return output;
  };
  const text = (input: string): string => capped(whole(input));
  return { text, whole, add };
};
