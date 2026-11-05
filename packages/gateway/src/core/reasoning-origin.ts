import type { ChatReasoningField, ReasoningInputItem, ReasoningItem, ReasoningOrigin } from '@momonga/protocol';
import { CHAT_REASONING_FIELDS } from '@momonga/protocol';
import { createSignedEnvelope } from './signed-envelope.ts';

const PAYLOAD_VERSION = 1;

export type ReasoningOriginCodec = {
  seal(adapter: string, model: string, item: ReasoningItem): ReasoningItem;
  originFor(adapter: string, model: string): ReasoningOrigin;
};

type Upstream = { encrypted_content?: string; signature?: string; reasoning_field?: ChatReasoningField };

const upstreamOf = (item: ReasoningItem): Upstream => ({
  ...(item.encrypted_content === undefined ? {} : { encrypted_content: item.encrypted_content }),
  ...(item.signature === undefined ? {} : { signature: item.signature }),
  ...(item.reasoning_field === undefined ? {} : { reasoning_field: item.reasoning_field }),
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const upstreamFrom = (value: unknown): Upstream | undefined => {
  if (!isRecord(value)) return undefined;
  const { encrypted_content: encrypted, signature, reasoning_field: field } = value;
  if (encrypted !== undefined && typeof encrypted !== 'string') return undefined;
  if (signature !== undefined && typeof signature !== 'string') return undefined;
  if (field !== undefined && !CHAT_REASONING_FIELDS.some((known) => known === field)) return undefined;
  return {
    ...(encrypted === undefined ? {} : { encrypted_content: encrypted }),
    ...(signature === undefined ? {} : { signature }),
    ...(field === undefined ? {} : { reasoning_field: field as ChatReasoningField }),
  };
};

const withoutUpstream = (item: ReasoningInputItem): ReasoningInputItem => {
  const { encrypted_content: _encrypted, signature: _signature, reasoning_field: _field, ...rest } = item;
  return rest;
};

export const createReasoningOriginCodec = (key: Uint8Array): ReasoningOriginCodec => {
  const envelope = createSignedEnvelope(key);
  return {
    seal: (adapter, model, item) => ({
      ...item,
      encrypted_content: envelope.seal({ v: PAYLOAD_VERSION, adapter, model, upstream: upstreamOf(item) }),
    }),
    originFor: (adapter, model) => ({
      own: (item) => {
        if (typeof item.encrypted_content !== 'string') return undefined;
        const payload = envelope.open(item.encrypted_content);
        if (payload === undefined || payload['v'] !== PAYLOAD_VERSION || payload['adapter'] !== adapter || payload['model'] !== model) return undefined;
        const upstream = upstreamFrom(payload['upstream']);
        return upstream === undefined ? undefined : { ...withoutUpstream(item), ...upstream };
      },
    }),
  };
};
