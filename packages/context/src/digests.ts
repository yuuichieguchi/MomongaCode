import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { InputItem } from '@momonga/protocol';
import type { DeepReadonly } from './types.ts';

const deepFreeze = (value: unknown): void => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
};

const itemDigests = new WeakMap<object, string>();

export const itemDigest = (item: InputItem): string => {
  const known = itemDigests.get(item);
  if (known !== undefined) return known;
  const digest = sha256Hex(canonicalJson(item));
  deepFreeze(item);
  itemDigests.set(item, digest);
  return digest;
};

export const digestChain = (context: unknown, items: readonly InputItem[]): string[] => {
  const chain = [sha256Hex(canonicalJson(context))];
  let current = chain[0] as string;
  for (const item of items) {
    current = sha256Hex(`${current}:${itemDigest(item)}`);
    chain.push(current);
  }
  return chain;
};

export const chainTail = (chain: readonly string[]): string => chain[chain.length - 1] as string;

export const frozenItem = (item: DeepReadonly<InputItem>): InputItem => {
  const mutableView = item as InputItem;
  itemDigest(mutableView);
  return mutableView;
};
