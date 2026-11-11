import { MalformedJsonError, parseExternalJson } from './json.ts';

export const parseUpstreamJson = (text: string, malformed: (what: string) => Error): unknown => {
  try {
    return parseExternalJson(text);
  } catch (error) {
    if (error instanceof MalformedJsonError) throw malformed(error.message);
    throw error;
  }
};

export const usableUpstreamJson = (text: string): unknown => {
  try {
    return parseExternalJson(text);
  } catch (error) {
    if (error instanceof MalformedJsonError) return undefined;
    throw error;
  }
};
