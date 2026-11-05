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
