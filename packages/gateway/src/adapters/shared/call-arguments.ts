import { isRecord } from '@momonga/foundation';
import { usableUpstreamJson } from './upstream-json.ts';

const parsedObjectOf = (text: string): Record<string, unknown> | undefined => {
  const parsed = usableUpstreamJson(text);
  return isRecord(parsed) ? parsed : undefined;
};

export const callArgumentsObject = (text: string): Record<string, unknown> => parsedObjectOf(text) ?? {};

export const callArgumentsText = (text: string): string => (parsedObjectOf(text) === undefined ? '{}' : text);
