import { isRecord, parseOutsideJson } from '@momonga/foundation';
import { SchemaValidatorFailure, checkWithPatterns, patternRefusal, validateUntrusted } from '@momonga/foundation';

export type ContentValue = string | number | boolean | string[];

export type FieldOption = { value: string; label: string };

export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'choice' | 'choices' | 'json';

export type FormField = {
  name: string;
  title: string;
  description?: string;
  required: boolean;
  kind: FieldKind;
  options: readonly FieldOption[];
  schema: Readonly<Record<string, unknown>>;
};

export type ParsedValue = { ok: true; value: ContentValue | undefined } | { ok: false; reason: 'invalid' | 'validator-failed'; error: string };

export type ElicitationOrigin = { server: string; key: string };

export type ContentCheck = { kind: 'valid' } | { kind: 'invalid'; message: string } | { kind: 'validator-failed'; message: string };

const optionsOfEnum = (schema: Record<string, unknown>): FieldOption[] | undefined => {
  const values = schema['enum'];
  if (Array.isArray(values) && values.every((value): value is string => typeof value === 'string')) {
    const names = schema['enumNames'];
    return values.map((value, index) => {
      const label = Array.isArray(names) ? names[index] : undefined;
      return { value, label: typeof label === 'string' ? label : value };
    });
  }
  const titled = schema['oneOf'] ?? schema['anyOf'];
  if (Array.isArray(titled) && titled.length > 0 && titled.every((entry) => isRecord(entry) && typeof entry['const'] === 'string')) {
    return titled.map((entry) => {
      const record = entry as Record<string, unknown>;
      const value = record['const'] as string;
      return { value, label: typeof record['title'] === 'string' ? record['title'] : value };
    });
  }
  return undefined;
};

const classify = (schema: Record<string, unknown>): { kind: FieldKind; options: FieldOption[] } => {
  const single = schema['type'] === 'string' || schema['type'] === undefined ? optionsOfEnum(schema) : undefined;
  if (single !== undefined) return { kind: 'choice', options: single };
  if (schema['type'] === 'array' && isRecord(schema['items'])) {
    const multiple = optionsOfEnum(schema['items']);
    if (multiple !== undefined) return { kind: 'choices', options: multiple };
  }
  switch (schema['type']) {
    case 'string':
      return { kind: 'string', options: [] };
    case 'number':
      return { kind: 'number', options: [] };
    case 'integer':
      return { kind: 'integer', options: [] };
    case 'boolean':
      return { kind: 'boolean', options: [] };
    default:
      return { kind: 'json', options: [] };
  }
};

export const fieldsOf = (requestedSchema: Readonly<Record<string, unknown>>): FormField[] => {
  const properties = requestedSchema['properties'];
  if (!isRecord(properties)) return [];
  const required = requestedSchema['required'];
  const requiredNames = new Set(Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : []);
  return Object.entries(properties).map(([name, entry]) => {
    const schema = isRecord(entry) ? entry : {};
    const { kind, options } = classify(schema);
    return {
      name,
      title: typeof schema['title'] === 'string' ? schema['title'] : name,
      ...(typeof schema['description'] === 'string' ? { description: schema['description'] } : {}),
      required: requiredNames.has(name),
      kind,
      options,
      schema,
    };
  });
};

const isContentValue = (value: unknown): value is ContentValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));

const TRUE_WORDS = ['y', 'yes', 'true', '1'];
const FALSE_WORDS = ['n', 'no', 'false', '0'];

const checkAgainst = async (origin: ElicitationOrigin, schema: Readonly<Record<string, unknown>>, value: unknown, label: string, signal: AbortSignal | undefined): Promise<ContentCheck> => {
  try {
    const checked = await checkWithPatterns(() => validateUntrusted(JSON.stringify(['cli-elicitation', origin.server, origin.key]), schema, value), signal === undefined ? {} : { signal });
    if (checked.kind === 'stopped') throw (signal as AbortSignal).reason;
    if (checked.kind === 'not-checked') return { kind: 'invalid', message: patternRefusal(label === '' ? 'answer' : `value of ${label}`, value, checked) };
    const verdict = checked.value;
    if (verdict.valid) return { kind: 'valid' };
    return { kind: 'invalid', message: verdict.errors.map((error) => `${label}${error.instancePath} ${error.message ?? error.keyword}`).join('; ') };
  } catch (error) {
    if (error instanceof SchemaValidatorFailure) return { kind: 'validator-failed', message: error.message };
    throw error;
  }
};

const optionOf = (field: FormField, token: string): string | undefined => {
  const trimmed = token.trim();
  const byNumber = /^\d+$/.test(trimmed) ? field.options[Number(trimmed) - 1] : undefined;
  if (byNumber !== undefined) return byNumber.value;
  return field.options.find((option) => option.value === trimmed || option.label === trimmed)?.value;
};

const coerce = (field: FormField, text: string): { ok: true; value: unknown } | { ok: false; reason: 'invalid'; error: string } => {
  switch (field.kind) {
    case 'string':
      return { ok: true, value: text };
    case 'number':
    case 'integer': {
      const value = Number(text);
      if (text.trim() === '' || !Number.isFinite(value)) return { ok: false, reason: 'invalid', error: `${field.name} must be a number` };
      return { ok: true, value };
    }
    case 'boolean': {
      const word = text.trim().toLowerCase();
      if (TRUE_WORDS.includes(word)) return { ok: true, value: true };
      if (FALSE_WORDS.includes(word)) return { ok: true, value: false };
      return { ok: false, reason: 'invalid', error: `${field.name} must be yes or no` };
    }
    case 'choice': {
      const value = optionOf(field, text);
      return value === undefined ? { ok: false, reason: 'invalid', error: `${field.name} must be one of the listed choices` } : { ok: true, value };
    }
    case 'choices': {
      const picked = text.split(',').map((token) => optionOf(field, token));
      if (picked.some((value) => value === undefined)) return { ok: false, reason: 'invalid', error: `${field.name} must be a comma separated list of the listed choices` };
      return { ok: true, value: picked };
    }
    case 'json':
      try {
        return { ok: true, value: parseOutsideJson(text) };
      } catch (error) {
        return { ok: false, reason: 'invalid', error: `${field.name} must be JSON: ${error instanceof Error ? error.message : String(error)}` };
      }
  }
};

export const parseFieldInput = async (origin: ElicitationOrigin, field: FormField, text: string, signal?: AbortSignal): Promise<ParsedValue> => {
  if (text === '' && field.kind !== 'string') {
    return field.required ? { ok: false, reason: 'invalid', error: `${field.name} is required` } : { ok: true, value: undefined };
  }
  if (text === '' && !field.required) return { ok: true, value: undefined };
  const coerced = coerce(field, text);
  if (!coerced.ok) return coerced;
  if (!isContentValue(coerced.value)) return { ok: false, reason: 'invalid', error: `${field.name} must be a string, a number, a boolean or a list of strings` };
  const check = await checkAgainst(origin, field.schema, coerced.value, field.name, signal);
  if (check.kind === 'validator-failed') return { ok: false, reason: 'validator-failed', error: check.message };
  if (check.kind === 'invalid') return { ok: false, reason: 'invalid', error: check.message };
  return { ok: true, value: coerced.value };
};

export const validateContent = async (
  origin: ElicitationOrigin,
  requestedSchema: Readonly<Record<string, unknown>>,
  content: Readonly<Record<string, ContentValue>>,
  signal?: AbortSignal,
): Promise<ContentCheck> => checkAgainst(origin, requestedSchema, content, '', signal);
