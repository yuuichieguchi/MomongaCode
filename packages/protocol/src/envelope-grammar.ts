const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

export type EnvelopeSegments = { payloadSegment: string; macSegment: string };

export const splitEnvelope = (token: string): EnvelopeSegments | undefined => {
  const segments = token.split('.');
  if (segments.length !== 2) return undefined;
  const [payloadSegment, macSegment] = segments as [string, string];
  if (!BASE64URL_SEGMENT.test(payloadSegment) || !BASE64URL_SEGMENT.test(macSegment)) return undefined;
  return { payloadSegment, macSegment };
};

export const joinEnvelope = ({ payloadSegment, macSegment }: EnvelopeSegments): string => `${payloadSegment}.${macSegment}`;

export const encodePayloadSegment = (payload: Record<string, unknown>): string => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

export const decodePayloadSegment = (payloadSegment: string): Record<string, unknown> | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
};
