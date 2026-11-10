import type { PublicRunEvent } from '@momonga/protocol';

export type PromptEvent = Extract<PublicRunEvent, { type: 'user.message' }>;

export const isPrompt = (event: PublicRunEvent, firstSeq: number | undefined): event is PromptEvent => event.type === 'user.message' && event.seq === firstSeq;
