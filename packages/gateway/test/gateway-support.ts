import net from 'node:net';
import { SAMPLING_FIELDS } from '@momonga/protocol';
import type { AdapterRequest, ProviderAdapter, StreamEvent } from '@momonga/protocol';
import { DEFAULT_SCRIPTED_CAPABILITIES, afterMicrotasks, responseResource, textResponseEvents, usageOf, waitFor } from '@momonga/testkit';
import { createTelemetry } from '@momonga/observability';
import type { Telemetry } from '@momonga/observability';
import type { FakeClock, FakeTimers } from '@momonga/testkit';
import { registerCleanup } from './gateway-helpers.ts';

export type HangingAdapter = ProviderAdapter & { readonly pulled: { count: number }; readonly signals: AbortSignal[] };

export const createHangingAdapter = (events: readonly StreamEvent[]): HangingAdapter => {
  const pulled = { count: 0 };
  const signals: AbortSignal[] = [];
  return {
    kind: 'hanging',
    sampling: { renders: SAMPLING_FIELDS },
    relaysClientBody: [],
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

export const RESPONSE_COMMITTED_EVENT = 'momonga.response.committed';

export type LiveSpan = { readonly name: string; readonly events: string[]; ended: boolean };

export type LiveSpanTelemetry = {
  readonly telemetry: Telemetry;
  readonly spans: LiveSpan[];
  attemptSpans(): LiveSpan[];
  commitCountsPerAttempt(): number[];
  commitEvents(): number;
};

const recordingSpan = <T extends object>(inner: T, live: LiveSpan): T =>
  new Proxy(inner, {
    get: (target, property, receiver) => {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'addEvent') {
        return (name: string, ...rest: unknown[]) => {
          live.events.push(name);
          return value.call(target, name, ...rest);
        };
      }
      if (property === 'end') {
        return (...rest: unknown[]) => {
          live.ended = true;
          return value.apply(target, rest);
        };
      }
      return value.bind(target);
    },
  });

export const createLiveSpanTelemetry = (clock: FakeClock): LiveSpanTelemetry => {
  const base = createTelemetry({ serviceName: 'momonga-gateway-test', serviceVersion: '0.0.0', clock });
  registerCleanup(() => base.shutdown());
  const spans: LiveSpan[] = [];
  const tracer = new Proxy(base.tracer, {
    get: (target, property, receiver) => {
      const value = Reflect.get(target, property, receiver);
      if (property !== 'startSpan' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
      return (name: string, ...rest: unknown[]) => {
        const live: LiveSpan = { name, events: [], ended: false };
        spans.push(live);
        return recordingSpan(value.call(target, name, ...rest), live);
      };
    },
  });
  const attemptSpans = (): LiveSpan[] => spans.filter((span) => span.name.startsWith('chat '));
  return {
    telemetry: { ...base, tracer },
    spans,
    attemptSpans,
    commitCountsPerAttempt: () => attemptSpans().map((span) => span.events.filter((name) => name === RESPONSE_COMMITTED_EVENT).length),
    commitEvents: () => attemptSpans().reduce((count, span) => count + span.events.filter((name) => name === RESPONSE_COMMITTED_EVENT).length, 0),
  };
};

const QUIET_TURNS = 200;

const settled = async (timers: FakeTimers, done: () => boolean): Promise<void> => {
  let seen = JSON.stringify(timers.pending());
  for (let quiet = 0; quiet < QUIET_TURNS && !done(); quiet += 1) {
    await afterMicrotasks();
    const now = JSON.stringify(timers.pending());
    if (now !== seen) {
      seen = now;
      quiet = 0;
    }
  }
};

export const advanceToNextWait = async (timers: FakeTimers, waits: ReadonlySet<number>, done: () => boolean, description: string): Promise<void> => {
  await waitFor(() => done() || timers.pending().some((timer) => waits.has(timer.delayMs)), { description });
  await settled(timers, done);
  const next = timers
    .pending()
    .filter((timer) => waits.has(timer.delayMs))
    .sort((a, b) => a.dueAt - b.dueAt)[0];
  if (!done() && next !== undefined) await timers.advanceAsync(Math.max(0, next.dueAt - timers.monotonicMs()));
};
