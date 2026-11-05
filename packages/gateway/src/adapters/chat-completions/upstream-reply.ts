import { decodeSse, isRecord, parseOutsideJson } from '@momonga/foundation';
import type { SseEvent } from '@momonga/foundation';
import { CONTEXT_WINDOW_EXCEEDED, GUARDRAIL_VIOLATION, StreamFailure, UNSUPPORTED_REQUEST } from '../shared/failures.ts';
import { errorObjectOf, upstreamErrorText } from './vocabulary.ts';
import type { ErrorVocabulary } from '../shared/vocabulary.ts';

const ERROR_EVENT = 'error';
const DONE_MARKER = '[DONE]';
const UNNAMED_UPSTREAM_ERROR = 'upstream_error';

export type UpstreamReply =
  | { kind: 'completion'; usage: Record<string, unknown> | undefined; body: unknown }
  | { kind: 'error'; status: number; body: unknown };

const parseJson = (text: string): unknown => {
  try {
    return parseOutsideJson(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

export const upstreamErrorEventBody = (event: SseEvent): { body: unknown } | undefined =>
  event.event === ERROR_EVENT ? { body: parseJson(event.data) ?? event.data } : undefined;

const usageOf = (body: unknown): Record<string, unknown> | undefined => {
  const usage = isRecord(body) ? body['usage'] : undefined;
  return isRecord(usage) ? usage : undefined;
};

async function* textSource(text: string): AsyncGenerator<string> {
  yield text;
}

type StreamedCall = { id?: string; name: string; arguments: string };

type StreamAssembly = {
  content: string;
  reasoningContent: string;
  reasoning: string;
  calls: Map<number, StreamedCall>;
  usage: Record<string, unknown> | undefined;
};

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

const takeDelta = (assembly: StreamAssembly, delta: Record<string, unknown>): void => {
  assembly.content += textOf(delta['content']);
  assembly.reasoningContent += textOf(delta['reasoning_content']);
  assembly.reasoning += textOf(delta['reasoning']);
  const calls = delta['tool_calls'];
  if (!Array.isArray(calls)) return;
  calls.forEach((raw, position) => {
    if (!isRecord(raw)) return;
    const index = typeof raw['index'] === 'number' ? raw['index'] : position;
    const fn = isRecord(raw['function']) ? raw['function'] : {};
    const call = assembly.calls.get(index) ?? { name: '', arguments: '' };
    if (typeof raw['id'] === 'string') call.id = raw['id'];
    call.name += textOf(fn['name']);
    call.arguments += textOf(fn['arguments']);
    assembly.calls.set(index, call);
  });
};

const takeChunk = (assembly: StreamAssembly, chunk: unknown): void => {
  if (!isRecord(chunk)) return;
  assembly.usage = usageOf(chunk) ?? assembly.usage;
  const choices = chunk['choices'];
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const delta = isRecord(first) ? first['delta'] : undefined;
  if (isRecord(delta)) takeDelta(assembly, delta);
};

const bodyOfStream = (assembly: StreamAssembly): unknown => {
  const message: Record<string, unknown> = { role: 'assistant', content: assembly.content };
  if (assembly.reasoningContent !== '') message['reasoning_content'] = assembly.reasoningContent;
  if (assembly.reasoning !== '') message['reasoning'] = assembly.reasoning;
  if (assembly.calls.size > 0) {
    message['tool_calls'] = [...assembly.calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({ ...(call.id === undefined ? {} : { id: call.id }), type: 'function', function: { name: call.name, arguments: call.arguments } }));
  }
  return { choices: [{ index: 0, message }], ...(assembly.usage === undefined ? {} : { usage: assembly.usage }) };
};

export const decodeUpstreamReply = async (status: number, text: string): Promise<UpstreamReply> => {
  if (status >= 400) return { kind: 'error', status, body: parseJson(text) ?? text };
  const json = parseJson(text);
  if (json !== undefined) return { kind: 'completion', usage: usageOf(json), body: json };
  const assembly: StreamAssembly = { content: '', reasoningContent: '', reasoning: '', calls: new Map(), usage: undefined };
  for await (const event of decodeSse(textSource(text))) {
    const failure = upstreamErrorEventBody(event);
    if (failure !== undefined) return { kind: 'error', status, body: failure.body };
    if (event.data === DONE_MARKER) break;
    takeChunk(assembly, parseJson(event.data));
  }
  return { kind: 'completion', usage: assembly.usage, body: bodyOfStream(assembly) };
};

export const upstreamErrorMessage = (body: unknown): string => {
  const text = upstreamErrorText(body);
  if (text !== undefined) return text;
  return typeof body === 'string' ? body : JSON.stringify(body);
};

export const upstreamErrorFailure = (vocabulary: ErrorVocabulary, status: number, body: unknown): StreamFailure => {
  const message = upstreamErrorMessage(body);
  const kind = vocabulary.kindOf(status, body);
  if (kind === 'guardrail') return new StreamFailure(GUARDRAIL_VIOLATION, 'model_error', message);
  if (kind === 'context_overflow') return new StreamFailure(CONTEXT_WINDOW_EXCEEDED, 'invalid_request', message);
  if (kind === 'unsupported') return new StreamFailure(UNSUPPORTED_REQUEST, 'invalid_request', message);
  const errorCode = errorObjectOf(body)?.['code'];
  const code = typeof errorCode === 'string' ? errorCode : UNNAMED_UPSTREAM_ERROR;
  return new StreamFailure(code, 'server_error', message);
};
