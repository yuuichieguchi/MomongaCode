import { createHmac, timingSafeEqual } from 'node:crypto';
import { decodePayloadSegment, encodePayloadSegment, joinEnvelope, splitEnvelope } from '@momonga/protocol';

export type EnvelopeDomain = 'compaction' | 'reasoning-origin';

export type SignedEnvelope = {
  seal(payload: Record<string, unknown>, domain: EnvelopeDomain): string;
  open(token: string, domain: EnvelopeDomain): Record<string, unknown> | undefined;
};

const sign = (key: Uint8Array, payloadSegment: string): Buffer => createHmac('sha256', key).update(payloadSegment).digest();

export const createSignedEnvelope = (key: Uint8Array): SignedEnvelope => ({
  seal: (payload, domain) => {
    const payloadSegment = encodePayloadSegment({ ...payload, typ: domain });
    return joinEnvelope({ payloadSegment, macSegment: sign(key, payloadSegment).toString('base64url') });
  },
  open: (token, domain) => {
    const segments = splitEnvelope(token);
    if (segments === undefined) return undefined;
    const presented = Buffer.from(segments.macSegment, 'base64url');
    const expected = sign(key, segments.payloadSegment);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined;
    const payload = decodePayloadSegment(segments.payloadSegment);
    return payload?.['typ'] === domain ? payload : undefined;
  },
});
