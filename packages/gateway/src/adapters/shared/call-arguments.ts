import { JsonDepthError, isRecord, parseOutsideJson } from '@momonga/foundation';

const parsedObjectOf = (text: string): Record<string, unknown> | undefined => {
  let parsed: unknown;
  try {
    parsed = parseOutsideJson(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof JsonDepthError) return undefined;
    throw error;
  }
  return isRecord(parsed) ? parsed : undefined;
};

export const callArgumentsObject = (text: string): Record<string, unknown> => parsedObjectOf(text) ?? {};

export const callArgumentsText = (text: string): string => (parsedObjectOf(text) === undefined ? '{}' : text);
