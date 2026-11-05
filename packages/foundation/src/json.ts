import { parseOutsideJson } from './json-depth.ts';

export const parseJsonOrText = (text: string): unknown => {
  try {
    return parseOutsideJson(text);
  } catch {
    return text;
  }
};

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
