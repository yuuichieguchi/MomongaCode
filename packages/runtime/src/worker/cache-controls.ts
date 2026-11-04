import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { BuiltContext } from '@momonga/context';
import type { PromptCacheCounts } from '@momonga/protocol';
import type { ClaimContext } from './claim-context.ts';
import { isRecord } from './json.ts';

export type CacheControls = { prompt_cache_key: string; momonga: { cache: PromptCacheCounts } };

const historyMarkOf = (body: unknown): number | undefined => {
  if (!isRecord(body) || !isRecord(body['momonga']) || !isRecord(body['momonga']['cache'])) return undefined;
  const { history } = body['momonga']['cache'];
  return typeof history === 'number' ? history : undefined;
};

const previousHistoryOf = (ctx: ClaimContext): number | undefined => {
  const { store } = ctx.options;
  const before = ctx.journal.state.lastSeq + 1;
  const previous = store.readLatestRunEventBefore(ctx.run.id, 'model.requested', before);
  if (previous === undefined) return undefined;
  const compacted = store.readLatestRunEventBefore(ctx.run.id, 'context.compacted', before);
  if (compacted !== undefined && compacted.seq > previous.seq) return undefined;
  return historyMarkOf(previous.body);
};

export const cacheControlsOf = (ctx: ClaimContext, built: BuiltContext): CacheControls => {
  const { stableEnd, fixedEnd, historyEnd } = built.zones;
  const previousHistory = previousHistoryOf(ctx);
  return {
    prompt_cache_key: sha256Hex(canonicalJson({ tools: built.tools, S: built.input.slice(0, stableEnd) })),
    momonga: { cache: { stable: stableEnd, fixed: fixedEnd, ...(previousHistory === undefined ? {} : { previousHistory }), history: historyEnd } },
  };
};
