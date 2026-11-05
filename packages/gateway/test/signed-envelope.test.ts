import { describe, expect, it } from 'vitest';
import { createCompactionCodec } from '../src/core/compaction.ts';
import { createReasoningOriginCodec } from '../src/core/reasoning-origin.ts';
import { createSignedEnvelope } from '../src/core/signed-envelope.ts';

const KEY = Buffer.from('momonga-signed-envelope-test-key-padded-32', 'utf8');

const BOTH = { v: 1, summary: 'a summary', adapter: 'ollama', model: 'm', upstream: {} };

const reasoningItem = (encrypted: string) => ({ type: 'reasoning' as const, id: 'rs_1', summary: [], encrypted_content: encrypted });

describe('a signed token is accepted only by the domain it was sealed for', () => {
  const envelope = createSignedEnvelope(KEY);

  it('opens with the sealing domain and refuses the other', () => {
    const compaction = envelope.seal(BOTH, 'compaction');
    const origin = envelope.seal(BOTH, 'reasoning-origin');
    expect(envelope.open(compaction, 'compaction')).toMatchObject({ summary: 'a summary' });
    expect(envelope.open(compaction, 'reasoning-origin')).toBeUndefined();
    expect(envelope.open(origin, 'reasoning-origin')).toMatchObject({ adapter: 'ollama' });
    expect(envelope.open(origin, 'compaction')).toBeUndefined();
  });

  it('keeps a token carrying both payload shapes out of the other codec', () => {
    const asCompaction = envelope.seal(BOTH, 'compaction');
    const asOrigin = envelope.seal(BOTH, 'reasoning-origin');
    const origin = createReasoningOriginCodec(KEY).originFor('ollama', 'm');
    expect(createCompactionCodec(KEY).decode(asCompaction)).toBe('a summary');
    expect(origin.own(reasoningItem(asCompaction))).toBeUndefined();
    expect(origin.own(reasoningItem(asOrigin))).toBeDefined();
    expect(createCompactionCodec(KEY).decode(asOrigin)).toBeUndefined();
  });

  it('refuses a token whose mac segment is not strict base64url', () => {
    const token = envelope.seal(BOTH, 'compaction');
    expect(envelope.open(`${token}=`, 'compaction')).toBeUndefined();
    expect(envelope.open(token.replace('.', '+.'), 'compaction')).toBeUndefined();
  });
});
