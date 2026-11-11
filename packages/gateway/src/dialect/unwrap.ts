import type { Segment, WrapRecord } from '@momonga/protocol';
import { MalformedJsonError, parseExternalJson } from '../adapters/shared/json.ts';
import { isRecord } from './schema.ts';

const reach = (value: unknown, path: readonly Segment[]): unknown[] => {
  let nodes: unknown[] = [value];
  for (const segment of path) {
    nodes = nodes.flatMap((node): unknown[] => {
      if ('items' in segment) return Array.isArray(node) ? node : [];
      return isRecord(node) && Object.hasOwn(node, segment.property) ? [node[segment.property]] : [];
    });
  }
  return nodes;
};

const readableReplyOf = (text: string): unknown => {
  try {
    return parseExternalJson(text);
  } catch (error) {
    if (error instanceof MalformedJsonError) return undefined;
    throw error;
  }
};

export const invertReply = (record: WrapRecord, text: string): string => {
  if (record.wrapped.length === 0) return text;
  const parsed = readableReplyOf(text);
  if (parsed === undefined) return text;
  let changed = false;
  for (const { at, property } of record.wrapped) {
    for (const node of reach(parsed, at)) {
      if (isRecord(node) && Object.hasOwn(node, property) && node[property] === null) {
        delete node[property];
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(parsed) : text;
};
