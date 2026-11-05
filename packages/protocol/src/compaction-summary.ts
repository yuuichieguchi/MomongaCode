import { decodePayloadSegment, splitEnvelope } from './envelope-grammar.ts';
import type { MessageInputItem } from './open-responses.ts';

const SUPPORTED_VERSION = 1;
export const decodeCompactionSummary = (encryptedContent: string): string | undefined => {
  const segments = splitEnvelope(encryptedContent);
  if (segments === undefined) return undefined;
  const payload = decodePayloadSegment(segments.payloadSegment);
  if (payload === undefined) return undefined;
  const { v, summary } = payload;
  if (v !== SUPPORTED_VERSION || typeof summary !== 'string') return undefined;
  return summary;
};

export const compactionSummaryMessage = (text: string): MessageInputItem => ({
  type: 'message',
  role: 'user',
  content: `<conversation_summary>\n${text.replaceAll('<', '&lt;')}\n</conversation_summary>`,
});
