import type { ReasoningOrigin } from '@momonga/protocol';
import { createReasoningOriginCodec } from '../src/core/reasoning-origin.ts';

export const EVERY_REASONING_IS_OWN: ReasoningOrigin = { own: (item) => item };

const KEY = Buffer.from('momonga-own-reasoning-test-key-padded-to-32', 'utf8');

export const originOf = (adapter: string, model: string): ReasoningOrigin => createReasoningOriginCodec(KEY).originFor(adapter, model);

export const sealedReasoning = (adapter: string, model: string, text: string) =>
  createReasoningOriginCodec(KEY).seal(adapter, model, { type: 'reasoning', id: 'rs_t', summary: [{ type: 'summary_text', text }] });
