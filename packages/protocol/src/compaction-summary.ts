import type { MessageInputItem } from './open-responses.ts';

const SUPPORTED_VERSION = 1;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

export const decodeCompactionSummary = (encryptedContent: string): string | undefined => {
  const segments = encryptedContent.split('.');
  if (segments.length !== 2) return undefined;
  if (!segments.every((segment) => BASE64URL_SEGMENT.test(segment))) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segments[0] as string, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { v, summary } = payload as Record<string, unknown>;
  if (v !== SUPPORTED_VERSION || typeof summary !== 'string') return undefined;
  return summary;
};

export const compactionSummaryMessage = (text: string): MessageInputItem => ({
  type: 'message',
  role: 'user',
  content: `<conversation_summary>\n${text.replaceAll('<', '&lt;')}\n</conversation_summary>`,
});
