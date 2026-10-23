import { createHmac, timingSafeEqual } from 'node:crypto';

const PAYLOAD_VERSION = 1;

export type CompactionCodec = {
  encode(summary: string): string;
  decode(encryptedContent: string): string | undefined;
};

const sign = (key: Uint8Array, payloadSegment: string): Buffer => createHmac('sha256', key).update(payloadSegment).digest();

const parseSummary = (payloadSegment: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const summary = (parsed as Record<string, unknown>)['summary'];
  return typeof summary === 'string' ? summary : undefined;
};

export const createCompactionCodec = (key: Uint8Array): CompactionCodec => ({
  encode: (summary) => {
    const payloadSegment = Buffer.from(JSON.stringify({ v: PAYLOAD_VERSION, summary }), 'utf8').toString('base64url');
    return `${payloadSegment}.${sign(key, payloadSegment).toString('base64url')}`;
  },
  decode: (encryptedContent) => {
    const parts = encryptedContent.split('.');
    if (parts.length !== 2) return undefined;
    const [payloadSegment, macSegment] = parts as [string, string];
    const presented = Buffer.from(macSegment, 'base64url');
    const expected = sign(key, payloadSegment);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined;
    return parseSummary(payloadSegment);
  },
});
