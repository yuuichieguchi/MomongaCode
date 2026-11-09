import { isRecord } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import type { AdapterRequest, JsonReplyPath, SchemaNarrowing, StreamEvent, Usage, WrapRecord } from '@momonga/protocol';
import { forbidsTools } from '../../core/tool-choice.ts';
import { StreamFailure, UpstreamProtocolError } from '../shared/failures.ts';
import { parseUpstreamJson } from '../shared/upstream-json.ts';
import { MAX_NDJSON_LINE_BYTES, MAX_TOOL_CALLS } from '../shared/limits.ts';
import { ResponseEmitter } from '../shared/response-emitter.ts';

export type OllamaStreamOptions = {
  request: AdapterRequest;
  clock: Clock;
  retryAfterMs?: number;
  wraps?: ReadonlyMap<string, WrapRecord>;
  narrowings?: readonly SchemaNarrowing[];
  jsonReply?: JsonReplyPath | undefined;
  onOutput?: () => void;
  outputCeiling?: number | undefined;
};

const invalid = (what: string): UpstreamProtocolError => new UpstreamProtocolError(`the upstream sent a malformed chunk: ${what}`);

const optionalString = (container: Record<string, unknown>, key: string, what: string): string | undefined => {
  const value = container[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`${what}.${key} must be a string`);
  return value;
};

const count = (container: Record<string, unknown>, key: string): number => {
  const value = container[key] === undefined ? 0 : container[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new UpstreamProtocolError(`the upstream's done chunk has a ${key} that is not a non-negative integer`);
  }
  return value;
};

const usageOf = (done: Record<string, unknown>): Usage => {
  const input = count(done, 'prompt_eval_count');
  const output = count(done, 'eval_count');
  const cached = count(done, 'prompt_eval_cached_count');
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: cached },
    output_tokens_details: { reasoning_tokens: 0 },
  };
};

class OllamaStreamDriver {
  private readonly emitter: ResponseEmitter;
  private readonly toolsAllowed: boolean;
  private started = false;
  private finished = false;

  constructor(options: OllamaStreamOptions) {
    this.emitter = new ResponseEmitter({ clock: options.clock, model: options.request.model, request: options.request, ...(options.wraps === undefined ? {} : { wraps: options.wraps }), ...(options.narrowings === undefined ? {} : { narrowings: options.narrowings }), jsonReply: options.jsonReply, ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }), ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }), outputCeiling: options.outputCeiling });
    this.toolsAllowed = !forbidsTools(options.request.tool_choice);
  }

  get hasStarted(): boolean {
    return this.started;
  }

  get terminated(): boolean {
    return this.emitter.terminated;
  }

  accept(line: string): StreamEvent[] {
    if (this.emitter.terminated) return [];
    try {
      this.apply(line);
    } catch (error) {
      if (!this.started || !(error instanceof StreamFailure)) throw error;
      this.emitter.fail(error.code, error.errorType, error.message);
    }
    return this.emitter.take();
  }

  fail(failure: StreamFailure): StreamEvent[] {
    if (!this.emitter.terminated) this.emitter.fail(failure.code, failure.errorType, failure.message);
    return this.emitter.take();
  }

  end(): StreamEvent[] {
    if (this.emitter.terminated) return this.emitter.take();
    const failure = new UpstreamProtocolError('the upstream stream ended without a done chunk');
    if (!this.started) throw new StreamFailure('empty_upstream_stream', 'server_error', 'the upstream ended its stream before sending any chunk');
    this.emitter.fail(failure.code, failure.errorType, failure.message);
    return this.emitter.take();
  }

  private apply(line: string): void {
    const parsed = parseUpstreamJson(line, invalid);
    if (!isRecord(parsed)) throw invalid('it is not a JSON object');
    if (!this.started) {
      this.started = true;
      this.emitter.start();
    }
    if (this.finished) throw new UpstreamProtocolError('the upstream sent a chunk after the done chunk');
    const failure = parsed['error'];
    if (typeof failure === 'string') throw new StreamFailure('upstream_error', 'server_error', failure);
    const message = parsed['message'];
    if (!isRecord(message)) throw invalid('message must be an object');
    const thinking = optionalString(message, 'thinking', 'message');
    if (thinking !== undefined) this.emitter.streamReasoning(thinking, undefined);
    const content = optionalString(message, 'content', 'message');
    if (content !== undefined) this.emitter.appendText(content);
    const calls = message['tool_calls'];
    if (calls !== undefined && calls !== null) {
      if (!Array.isArray(calls)) throw invalid('message.tool_calls must be an array');
      for (const call of calls) this.acceptCall(call);
    }
    const done = parsed['done'];
    if (typeof done !== 'boolean') throw invalid('done must be a boolean');
    if (done) {
      this.finished = true;
      this.conclude(parsed);
    }
  }

  private acceptCall(call: unknown): void {
    if (!this.toolsAllowed) throw new UpstreamProtocolError('the upstream sent a tool call although the request set tool_choice none');
    if (!isRecord(call)) throw invalid('a tool_calls entry must be an object');
    if (this.emitter.callCount >= MAX_TOOL_CALLS) throw new UpstreamProtocolError(`the upstream sent more than ${MAX_TOOL_CALLS} tool calls`);
    const id = call['id'];
    if (typeof id !== 'string' || id === '') throw new UpstreamProtocolError('the upstream sent a tool call without an id');
    const fn = call['function'];
    if (!isRecord(fn)) throw invalid('tool_calls[].function must be an object');
    const name = fn['name'];
    if (typeof name !== 'string' || name === '') throw invalid('tool_calls[].function.name must be a non-empty string');
    const args = fn['arguments'];
    if (!isRecord(args)) throw invalid('tool_calls[].function.arguments must be an object');
    const key = this.emitter.callCount;
    this.emitter.endMessage();
    this.emitter.beginCall(key, id, name);
    this.emitter.appendCallArguments(key, JSON.stringify(args));
    this.emitter.completeCall(key);
  }

  private conclude(done: Record<string, unknown>): void {
    const reason = done['done_reason'];
    if (typeof reason !== 'string') throw new UpstreamProtocolError('the upstream\'s done chunk lacks done_reason');
    const usage = usageOf(done);
    if (reason === 'stop') {
      this.emitter.complete(usage);
      return;
    }
    if (reason === 'length') {
      this.emitter.incomplete('max_output_tokens', usage);
      return;
    }
    throw new UpstreamProtocolError(`the upstream ended the response for the unsupported done_reason ${JSON.stringify(reason)}`);
  }
}

const LINE_FEED = 0x0a;

async function* linesOf(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const take = (): string => {
    const joined = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    try {
      return decoder.decode(joined);
    } catch {
      throw new UpstreamProtocolError('an upstream NDJSON line is not valid UTF-8');
    }
  };
  for await (const chunk of body) {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(LINE_FEED, start);
      const piece = chunk.subarray(start, end === -1 ? chunk.length : end);
      pending.push(piece);
      pendingBytes += piece.length;
      if (pendingBytes > MAX_NDJSON_LINE_BYTES) throw new UpstreamProtocolError(`an upstream NDJSON line exceeds ${MAX_NDJSON_LINE_BYTES} bytes`);
      if (end === -1) break;
      const line = take();
      if (line.trim() !== '') yield line;
      start = end + 1;
    }
  }
  const last = take();
  if (last.trim() !== '') yield last;
}

export async function* ollamaEventsOf(body: AsyncIterable<Uint8Array>, options: OllamaStreamOptions): AsyncGenerator<StreamEvent> {
  const driver = new OllamaStreamDriver(options);
  try {
    for await (const line of linesOf(body)) {
      for (const event of driver.accept(line)) yield event;
      if (driver.terminated) return;
    }
  } catch (error) {
    if (!(error instanceof UpstreamProtocolError) || !driver.hasStarted) throw error;
    for (const event of driver.fail(error)) yield event;
    return;
  }
  for (const event of driver.end()) yield event;
}
