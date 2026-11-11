import { JsonDepthError, parseOutsideJson } from '@momonga/foundation';

export const NOT_VALID_JSON = 'is not valid JSON';

export const parsePlanJson = (text: string, refusal: (problem: typeof NOT_VALID_JSON) => Error): unknown => {
  try {
    return parseOutsideJson(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof JsonDepthError) throw refusal(NOT_VALID_JSON);
    throw error;
  }
};
