import { itemCapFor } from '@momonga/context';
import type { Capabilities } from '@momonga/protocol';
import { MINIMUM_INLINE_OUTPUT_CHARS } from '@momonga/tools';

const MAX_INLINE_OUTPUT_CHARS = 30_000;
const CHARS_PER_ITEM_CAP_TOKEN = 3;

export const inlineLimitForItemCap = (itemCap: number): number =>
  Math.max(MINIMUM_INLINE_OUTPUT_CHARS, Math.min(MAX_INLINE_OUTPUT_CHARS, CHARS_PER_ITEM_CAP_TOKEN * itemCap));

export const inlineOutputLimitFor = (capabilities: Capabilities): number => inlineLimitForItemCap(itemCapFor(capabilities));
