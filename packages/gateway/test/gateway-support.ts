import net from 'node:net';
import type { AdapterRequest, ProviderAdapter, StreamEvent } from '@momonga/protocol';
import { DEFAULT_SCRIPTED_CAPABILITIES, responseResource, textResponseEvents, usageOf } from '@momonga/testkit';
import { registerCleanup } from './gateway-helpers.ts';

export type HangingAdapter = ProviderAdapter & { readonly pulled: { count: number }; readonly signals: AbortSignal[] };

export const createHangingAdapter = (events: readonly StreamEvent[]): HangingAdapter => {
  const pulled = { count: 0 };
  const signals: AbortSignal[] = [];
  return {
    kind: 'hanging',
    pulled,
    signals,
    capabilities: async () => DEFAULT_SCRIPTED_CAPABILITIES,
    toolChoiceWire: () => ({ forms: [], expressesRequired: true }),
    create: async function* (_request: AdapterRequest, ctx): AsyncGenerator<StreamEvent> {
      signals.push(ctx.signal);
      for (const event of events) {
        pulled.count += 1;
        yield event;
      }
      await new Promise<never>(() => undefined);
    },
    classify: (error) => ({
      retryable: false,
      error: { type: 'model_error', code: 'adapter_error', message: error instanceof Error ? error.message : String(error), param: null },
    }),
  };
};

export const bigTextEvents = (chunks: number, chunkBytes: number): StreamEvent[] =>
  textResponseEvents({ model: 'scripted-primary', chunks: Array.from({ length: chunks }, () => 'x'.repeat(chunkBytes)) });

export const incompleteEvents = (text: string): StreamEvent[] => {
  const events = textResponseEvents({ model: 'scripted-primary', chunks: [text], usage: usageOf(5, 5) });
  const last = events[events.length - 1];
  if (last === undefined || last.type !== 'response.completed') throw new Error('unexpected fixture shape');
  return [
    ...events.slice(0, -1),
    {
      type: 'response.incomplete',
      sequence_number: last.sequence_number,
      response: { ...last.response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    },
  ];
};

export const functionCallEvents = (callId: string, name: string, args: string): StreamEvent[] => {
  const itemId = 'fc_upstream_1';
  const done = { type: 'function_call' as const, id: itemId, call_id: callId, name, arguments: args, status: 'completed' as const };
  return [
    { type: 'response.created', sequence_number: 0, response: responseResource({ id: 'up_1', model: 'm', status: 'in_progress' }) },
    { type: 'response.in_progress', sequence_number: 1, response: responseResource({ id: 'up_1', model: 'm', status: 'in_progress' }) },
    {
      type: 'response.output_item.added',
      sequence_number: 2,
      output_index: 0,
      item: { ...done, arguments: '', status: 'in_progress' },
    },
    { type: 'response.function_call_arguments.delta', sequence_number: 3, item_id: itemId, output_index: 0, delta: args },
    { type: 'response.function_call_arguments.done', sequence_number: 4, item_id: itemId, output_index: 0, arguments: args },
    { type: 'response.output_item.done', sequence_number: 5, output_index: 0, item: done },
    {
      type: 'response.completed',
      sequence_number: 6,
      response: responseResource({ id: 'up_1', model: 'm', status: 'completed', output: [done], usage: usageOf(3, 3), completedAt: 1_800_000_001 }),
    },
  ];
};

export type RawStreamClient = { socket: net.Socket };

export type RawPostOptions = { headers?: Record<string, string>; paused?: boolean };

export const openRawPost = async (
  socketPath: string,
  urlPath: string,
  body: unknown,
  options: RawPostOptions = {},
): Promise<RawStreamClient> => {
  const payload = JSON.stringify(body);
  const socket = net.connect(socketPath);
  registerCleanup(() => {
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.on('error', () => undefined);
  if (options.paused === true) socket.pause();
  else socket.on('data', () => undefined);
  const extraHeaders = Object.entries(options.headers ?? {})
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('');
  socket.write(
    `POST ${urlPath} HTTP/1.1\r\nhost: localhost\r\ncontent-type: application/json\r\n${extraHeaders}content-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
  );
  return { socket };
};

export const openUnreadStream = (socketPath: string, body: unknown): Promise<RawStreamClient> =>
  openRawPost(socketPath, '/v1/responses', body, { paused: true });
