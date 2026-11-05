import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { BuiltContext } from '@momonga/context';
import type { PromptCacheCounts } from '@momonga/protocol';
import type { ClaimContext } from './claim-context.ts';
import { isRecord } from './json.ts';
import type { PrefixRelation } from './prefix-relation.ts';

export type CacheControls = { prompt_cache_key: string; momonga: { cache: PromptCacheCounts } };

const historyMarkOf = (body: unknown): number | undefined => {
  if (!isRecord(body) || !isRecord(body['momonga']) || !isRecord(body['momonga']['cache'])) return undefined;
  const { history } = body['momonga']['cache'];
  return typeof history === 'number' ? history : undefined;
};

const previousHistoryOf = (ctx: ClaimContext, prefix: PrefixRelation | undefined): number | undefined => {
  if (prefix === undefined || prefix.toolsChanged) return undefined;
  const previous = ctx.options.store.readLatestRunEventBefore(ctx.run.id, 'model.requested', ctx.journal.state.lastSeq + 1);
  if (previous === undefined) return undefined;
  const mark = historyMarkOf(previous.body);
  return mark !== undefined && prefix.preservedItems >= mark ? mark : undefined;
};

export const cacheControlsOf = (ctx: ClaimContext, built: BuiltContext, prefix: PrefixRelation | undefined): CacheControls => {
  const { stableEnd, fixedEnd, historyEnd } = built.zones;
  const previousHistory = previousHistoryOf(ctx, prefix);
  return {
    prompt_cache_key: sha256Hex(canonicalJson({ tools: built.tools, S: built.input.slice(0, stableEnd) })),
    momonga: { cache: { stable: stableEnd, fixed: fixedEnd, ...(previousHistory === undefined ? {} : { previousHistory }), history: historyEnd } },
  };
};
