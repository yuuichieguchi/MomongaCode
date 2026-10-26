import type { FakeChatCompletionsServer, FakeScriptedReply, RecordedRequest } from '@momonga/testkit';

export const SCRIPTED_USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } as const;

export type ChatMessage = { readonly role: string; readonly content: unknown; readonly tool_call_id?: string; readonly tool_calls?: unknown };

export const toolCallReply = (name: string, args: Readonly<Record<string, unknown>>, callId = 'call_1'): FakeScriptedReply => ({
  kind: 'stream',
  chunks: [
    {
      delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      finishReason: 'tool_calls',
    },
  ],
  usage: SCRIPTED_USAGE,
});

export const textReply = (text: string): FakeScriptedReply => ({
  kind: 'stream',
  chunks: [{ delta: { role: 'assistant', content: text } }, { delta: {}, finishReason: 'stop' }],
  usage: SCRIPTED_USAGE,
});

export type EnvelopeCall = { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> };

export const envelopeToolCallsReply = (calls: readonly EnvelopeCall[]): FakeScriptedReply =>
  textReply(JSON.stringify({ kind: 'tool_calls', calls: calls.map((call) => ({ name: call.name, arguments: call.arguments })) }));

export const envelopeFinalReply = (text: string): FakeScriptedReply => textReply(JSON.stringify({ kind: 'final', text }));

export const hangReply = (text: string): FakeScriptedReply => ({
  kind: 'hang',
  chunks: [{ delta: { role: 'assistant', content: text } }],
});

export const chatCompletions = (fake: Pick<FakeChatCompletionsServer, 'requests'>): RecordedRequest[] =>
  fake.requests.filter((request) => request.method === 'POST' && request.path === '/v1/chat/completions');

const isChatMessage = (value: unknown): value is ChatMessage =>
  typeof value === 'object' &&
  value !== null &&
  'role' in value &&
  typeof value.role === 'string' &&
  (!('tool_call_id' in value) || typeof value.tool_call_id === 'string');

export const messagesOf = (request: RecordedRequest | undefined): ChatMessage[] => {
  if (request === undefined) throw new Error('missing upstream request');
  const body = request.body;
  if (typeof body !== 'object' || body === null || !('messages' in body) || !Array.isArray(body.messages)) {
    throw new Error('upstream request body has no messages array');
  }
  const messages: unknown[] = body.messages;
  return messages.map((message) => {
    if (!isChatMessage(message)) throw new Error(`upstream request carries a malformed chat message: ${JSON.stringify(message)}`);
    return message;
  });
};

const firstToolCallIdOf = (message: ChatMessage): string | undefined => {
  const toolCalls = message.tool_calls;
  if (!Array.isArray(toolCalls)) return undefined;
  const first: unknown = toolCalls[0];
  if (typeof first !== 'object' || first === null || !('id' in first) || typeof first.id !== 'string') return undefined;
  return first.id;
};

export const precedingAssistantCallId = (messages: readonly ChatMessage[], toolMessage: ChatMessage | undefined): string => {
  if (toolMessage === undefined) throw new Error('missing tool message');
  const toolIndex = messages.indexOf(toolMessage);
  if (toolIndex < 1) throw new Error('tool message is not preceded by any message');
  const assistant = messages[toolIndex - 1];
  if (assistant?.role !== 'assistant') throw new Error(`message before the tool message has role ${String(assistant?.role)}`);
  const callId = firstToolCallIdOf(assistant);
  if (callId === undefined) throw new Error('preceding assistant message has no tool_calls[0].id');
  return callId;
};
