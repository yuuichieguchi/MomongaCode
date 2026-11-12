import type { ErrorVocabulary, UpstreamErrorKind } from '../adapters/shared/vocabulary.ts';
import type { UpstreamReply } from '../adapters/chat-completions/upstream-reply.ts';
import { ProbeTimeoutError } from './client.ts';
import type { HttpResult } from './client.ts';
import { field, firstOf } from './reply.ts';

export type ProbeOutcome = 'accepted' | 'unsupported' | 'overflow' | 'too_large' | 'failure';

export type ChatResult = HttpResult & { reply: UpstreamReply; outcome: ProbeOutcome; errorKind: UpstreamErrorKind | undefined };

export const errorKindOf = (vocabulary: ErrorVocabulary, reply: UpstreamReply): UpstreamErrorKind | undefined =>
  reply.kind === 'error' ? vocabulary.kindOf(reply.status, reply.body) : undefined;

export const outcomeOf = (status: number, reply: UpstreamReply, kind: UpstreamErrorKind | undefined): ProbeOutcome => {
  if (reply.kind === 'completion') return status === 200 ? 'accepted' : 'failure';
  if (kind === 'context_overflow') return 'overflow';
  if (kind === 'payload_too_large') return 'too_large';
  return kind === 'unsupported' ? 'unsupported' : 'failure';
};

const reportsError = (result: HttpResult | ChatResult): boolean => 'reply' in result && result.reply.kind === 'error';

export const expectStatus = (result: HttpResult | ChatResult, allowed: readonly number[], what: string): void => {
  if (!allowed.includes(result.status) || (result.status < 400 && reportsError(result))) {
    throw new Error(`Probe step "${what}" failed with HTTP ${result.status}`);
  }
};

export const failProbeStep = (result: HttpResult, what: string): never => {
  throw new Error(`Probe step "${what}" failed with HTTP ${result.status}`);
};

export const isAcceptedOrRejected = (result: ChatResult, what: string): boolean => {
  if (result.outcome === 'accepted') return true;
  if (result.outcome === 'unsupported') return false;
  return failProbeStep(result, what);
};

export const isFirstSampleAccepted = (result: ChatResult | undefined, what: string): boolean => {
  if (result === undefined) throw new Error(`Probe step "${what}" timed out on its first sample`);
  return isAcceptedOrRejected(result, what);
};

export const assistantMessage = (body: unknown): unknown => field(firstOf(field(body, 'choices')), 'message');

export const promptTokensOf = (body: unknown): number | undefined => {
  const tokens = field(field(body, 'usage'), 'prompt_tokens');
  return typeof tokens === 'number' ? tokens : undefined;
};

export type Chat = (body: Record<string, unknown>) => Promise<ChatResult>;

export const sampleRequest = async (chat: Chat, body: Record<string, unknown>): Promise<ChatResult | undefined> => {
  try {
    return await chat(body);
  } catch (error) {
    if (error instanceof ProbeTimeoutError) return undefined;
    throw error;
  }
};

