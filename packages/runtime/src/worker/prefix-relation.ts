import { canonicalJson } from '@momonga/foundation';
import type { FunctionTool, InputItem } from '@momonga/protocol';

export type RequestShape = { input: readonly InputItem[]; tools: readonly FunctionTool[] };

export type PrefixRelation = { preservedItems: number; toolsChanged: boolean };

export const prefixRelationOf = (previous: RequestShape, next: RequestShape): PrefixRelation => {
  if (canonicalJson(previous.tools) !== canonicalJson(next.tools)) return { preservedItems: 0, toolsChanged: true };
  let preservedItems = 0;
  while (
    preservedItems < previous.input.length &&
    preservedItems < next.input.length &&
    canonicalJson(previous.input[preservedItems]) === canonicalJson(next.input[preservedItems])
  ) {
    preservedItems += 1;
  }
  return { preservedItems, toolsChanged: false };
};
