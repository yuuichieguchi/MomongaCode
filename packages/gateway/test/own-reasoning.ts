import type { AdapterContext, AdapterTarget, ProviderAdapter, ReasoningOrigin } from '@momonga/protocol';
import { createReasoningOriginCodec } from '../src/core/reasoning-origin.ts';

export const EVERY_REASONING_IS_OWN: ReasoningOrigin = { own: (item) => item };

export const contextOf = async (
  adapter: Pick<ProviderAdapter, 'capabilities'>,
  target: AdapterTarget,
  signal: AbortSignal = new AbortController().signal,
): Promise<AdapterContext> => ({
  signal,
  target,
  attempt: 1,
  reasoningOrigin: EVERY_REASONING_IS_OWN,
  capabilities: await adapter.capabilities(target),
});

const KEY = Buffer.from('momonga-own-reasoning-test-key-padded-to-32', 'utf8');

export const originOf = (adapter: string, model: string): ReasoningOrigin => createReasoningOriginCodec(KEY).originFor(adapter, model);

export const sealedReasoning = (adapter: string, model: string, text: string) =>
  createReasoningOriginCodec(KEY).seal(adapter, model, { type: 'reasoning', id: 'rs_t', summary: [{ type: 'summary_text', text }] });

export const REASONING_ORIGIN_CODEC = createReasoningOriginCodec(KEY);
