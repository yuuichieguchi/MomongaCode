import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignedEnvelope = {
  seal(payload: Record<string, unknown>): string;
  open(token: string): Record<string, unknown> | undefined;
};

const sign = (key: Uint8Array, payloadSegment: string): Buffer => createHmac('sha256', key).update(payloadSegment).digest();

const parsePayload = (payloadSegment: string): Record<string, unknown> | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
};

export const createSignedEnvelope = (key: Uint8Array): SignedEnvelope => ({
  seal: (payload) => {
    const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${payloadSegment}.${sign(key, payloadSegment).toString('base64url')}`;
  },
  open: (token) => {
    const parts = token.split('.');
    if (parts.length !== 2) return undefined;
    const [payloadSegment, macSegment] = parts as [string, string];
    const presented = Buffer.from(macSegment, 'base64url');
    const expected = sign(key, payloadSegment);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined;
    return parsePayload(payloadSegment);
  },
});
