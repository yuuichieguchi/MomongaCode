import { JsonDepthError, parseOutsideJson } from '@momonga/foundation';

export const parseUpstreamJson = (text: string, malformed: (what: string) => Error): unknown => {
  try {
    return parseOutsideJson(text);
  } catch (error) {
    if (error instanceof JsonDepthError) throw malformed(error.message);
    if (error instanceof SyntaxError) throw malformed('it is not valid JSON');
    throw error;
  }
};

export const usableUpstreamJson = (text: string): unknown => {
  try {
    return parseOutsideJson(text);
  } catch (error) {
    if (error instanceof JsonDepthError || error instanceof SyntaxError) return undefined;
    throw error;
  }
};
