import { createSignedEnvelope } from './signed-envelope.ts';

const PAYLOAD_VERSION = 1;

export type CompactionCodec = {
  encode(summary: string): string;
  decode(encryptedContent: string): string | undefined;
};

export const createCompactionCodec = (key: Uint8Array): CompactionCodec => {
  const envelope = createSignedEnvelope(key);
  return {
    encode: (summary) => envelope.seal({ v: PAYLOAD_VERSION, summary }),
    decode: (encryptedContent) => {
      const summary = envelope.open(encryptedContent)?.['summary'];
      return typeof summary === 'string' ? summary : undefined;
    },
  };
};
