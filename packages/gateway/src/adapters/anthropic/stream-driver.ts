import { cachedDetailOf } from '@momonga/protocol';
import type { ErrorType, StreamEvent, Usage } from '@momonga/protocol';
import { CONTEXT_WINDOW_EXCEEDED, UpstreamProtocolError } from '../shared/failures.ts';
import { MAX_TOOL_CALLS } from '../shared/limits.ts';
import type { ResponseEmitter } from '../shared/response-emitter.ts';
import { AssistantRecorder } from './assistant-recorder.ts';
import type { AnthropicStreamEvent, AnthropicUsageFields } from './events.ts';
import { streamErrorOf } from './errors.ts';

type BlockState = { kind: 'text' } | { kind: 'thinking'; key: number } | { kind: 'tool'; key: number; receivedArguments: boolean } | { kind: 'ignored' };

const EMPTY_ARGUMENTS = '{}';
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;

const addUsage = (left: AnthropicUsageFields, right: AnthropicUsageFields): AnthropicUsageFields => {
  const sum: AnthropicUsageFields = {};
  for (const key of USAGE_KEYS) {
    if (left[key] !== undefined || right[key] !== undefined) sum[key] = (left[key] ?? 0) + (right[key] ?? 0);
  }
  return sum;
};

const usageOf = (fields: AnthropicUsageFields): Usage | undefined => {
  if (Object.keys(fields).length === 0) return undefined;
  const input = inputTokensOf(fields);
  const output = fields.output_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: cachedDetailOf(fields.cache_read_input_tokens),
    output_tokens_details: { reasoning_tokens: 0 },
  };
};

export const inputTokensOf = (fields: AnthropicUsageFields): number =>
  (fields.input_tokens ?? 0) + (fields.cache_creation_input_tokens ?? 0) + (fields.cache_read_input_tokens ?? 0);

export type Continuation = { usage: AnthropicUsageFields; firstInputTokens: number };

export class AnthropicStreamDriver {
  private readonly emitter: ResponseEmitter;
  private readonly blocks = new Map<number, BlockState>();
  private readonly recorder = new AssistantRecorder();
  private readonly carriedUsage: AnthropicUsageFields;
  private readonly resumed: boolean;
  private readonly firstInputTokens: number | undefined;
  private segmentUsage: AnthropicUsageFields = {};
  private stopReason: string | undefined;
  private segmentStarted = false;
  private pausedTurn = false;
  private pausedBlocks: Record<string, unknown>[] = [];

  constructor(emitter: ResponseEmitter, continuation?: Continuation) {
    this.emitter = emitter;
    this.resumed = continuation !== undefined;
    this.carriedUsage = continuation?.usage ?? {};
    this.firstInputTokens = continuation?.firstInputTokens;
  }

  get hasStarted(): boolean {
    return this.resumed || this.segmentStarted;
  }

  get terminated(): boolean {
    return this.emitter.terminated;
  }

  get paused(): boolean {
    return this.pausedTurn;
  }

  get concluded(): boolean {
    return this.emitter.terminated || this.pausedTurn;
  }

  pausedContent(): Record<string, unknown>[] {
    return this.pausedBlocks;
  }

  accumulatedUsage(): AnthropicUsageFields {
    return addUsage(this.carriedUsage, this.segmentUsage);
  }

  accept(event: AnthropicStreamEvent): StreamEvent[] {
    if (this.emitter.terminated) return [];
    try {
      this.apply(event);
    } catch (error) {
      if (!this.hasStarted || !(error instanceof UpstreamProtocolError)) throw error;
      this.emitter.fail(error.code, error.errorType, error.message);
    }
    return this.emitter.take();
  }

  end(): StreamEvent[] {
    if (this.concluded) return this.emitter.take();
    const failure = new UpstreamProtocolError('the upstream stream ended without a message_stop event');
    if (!this.hasStarted) throw failure;
    return this.fail(failure);
  }

  fail(failure: { code: string; errorType: ErrorType; message: string }): StreamEvent[] {
    if (!this.emitter.terminated) this.emitter.fail(failure.code, failure.errorType, failure.message);
    return this.emitter.take();
  }

  private apply(event: AnthropicStreamEvent): void {
    if (event.type === 'error') throw streamErrorOf(event.errorType, event.message);
    if (!this.segmentStarted) {
      if (event.type === 'ping' || event.type === 'unknown') return;
      if (event.type !== 'message_start') throw new UpstreamProtocolError(`the upstream sent ${event.type} before message_start`);
      this.segmentStarted = true;
      this.segmentUsage = { ...event.usage };
      if (!this.resumed) this.emitter.start();
      return;
    }
    switch (event.type) {
      case 'ping':
      case 'unknown':
        return;
      case 'message_start':
        throw new UpstreamProtocolError('the upstream sent message_start twice');
      case 'content_block_start':
        this.startBlock(event);
        return;
      case 'content_block_delta':
        this.applyDelta(event);
        return;
      case 'content_block_stop':
        this.stopBlock(event.index);
        return;
      case 'message_delta':
        if (event.stopReason !== undefined) this.stopReason = event.stopReason;
        this.segmentUsage = { ...this.segmentUsage, ...event.usage };
        return;
      case 'message_stop':
        this.conclude();
        return;
    }
  }

  private startBlock(event: Extract<AnthropicStreamEvent, { type: 'content_block_start' }>): void {
    if (this.blocks.has(event.index)) throw new UpstreamProtocolError(`the upstream started content block ${event.index} twice`);
    const { block } = event;
    this.recorder.start(event.index, block);
    if (block.kind === 'text') {
      this.blocks.set(event.index, { kind: 'text' });
      if (block.text !== '') this.emitter.appendText(block.text);
      return;
    }
    if (block.kind === 'thinking') {
      const key = this.emitter.reasoningCount;
      this.blocks.set(event.index, { kind: 'thinking', key });
      this.emitter.beginReasoning(key);
      this.emitter.appendReasoning(key, block.thinking);
      return;
    }
    if (block.kind === 'tool_use') {
      if (this.emitter.callCount >= MAX_TOOL_CALLS) throw new UpstreamProtocolError(`the upstream sent more than ${MAX_TOOL_CALLS} tool calls`);
      if (block.id === '' || block.name === '') throw new UpstreamProtocolError(`tool_use block ${event.index} lacks an id or a name`);
      const key = this.emitter.callCount;
      this.blocks.set(event.index, { kind: 'tool', key, receivedArguments: false });
      this.emitter.beginCall(key, block.id, block.name);
      return;
    }
    this.blocks.set(event.index, { kind: 'ignored' });
  }

  private applyDelta(event: Extract<AnthropicStreamEvent, { type: 'content_block_delta' }>): void {
    const block = this.blocks.get(event.index);
    if (block === undefined) throw new UpstreamProtocolError(`the upstream sent a delta for the unopened content block ${event.index}`);
    const { delta } = event;
    this.recorder.apply(event.index, delta);
    if (block.kind === 'thinking') {
      if (delta.kind === 'thinking') this.emitter.appendReasoning(block.key, delta.thinking);
      else if (delta.kind === 'signature') this.emitter.annotateReasoning(block.key, { signature: delta.signature });
      else if (delta.kind !== 'other') throw new UpstreamProtocolError(`a ${delta.kind} delta arrived for the thinking block ${event.index}`);
      return;
    }
    if (delta.kind === 'other' || delta.kind === 'thinking' || delta.kind === 'signature' || delta.kind === 'citation' || block.kind === 'ignored') return;
    if (delta.kind === 'text') {
      if (block.kind !== 'text') throw new UpstreamProtocolError(`a text delta arrived for the tool_use block ${event.index}`);
      this.emitter.appendText(delta.text);
      return;
    }
    if (block.kind !== 'tool') throw new UpstreamProtocolError(`an input_json delta arrived for the text block ${event.index}`);
    if (delta.partialJson !== '') block.receivedArguments = true;
    this.emitter.appendCallArguments(block.key, delta.partialJson);
  }

  private stopBlock(index: number): void {
    const block = this.blocks.get(index);
    if (block === undefined) throw new UpstreamProtocolError(`the upstream stopped the unopened content block ${index}`);
    if (block.kind === 'thinking') this.emitter.completeReasoning(block.key);
    if (block.kind === 'tool' && !block.receivedArguments) this.emitter.appendCallArguments(block.key, EMPTY_ARGUMENTS);
    this.recorder.stop(index);
  }

  private conclude(): void {
    const accumulated = this.accumulatedUsage();
    const usage = usageOf(accumulated);
    const cacheWrite = accumulated.cache_creation_input_tokens;
    switch (this.stopReason) {
      case undefined:
        throw new UpstreamProtocolError('the upstream sent message_stop without a stop_reason');
      case 'end_turn':
      case 'stop_sequence':
      case 'tool_use':
        this.emitter.complete(usage, this.firstInputTokens, cacheWrite);
        return;
      case 'pause_turn':
        if (this.recorder.unfinished > 0) throw new UpstreamProtocolError('the upstream paused the turn with a content block still open');
        this.pausedBlocks = this.recorder.continuationContent();
        this.pausedTurn = true;
        return;
      case 'max_tokens':
        this.emitter.incomplete('max_output_tokens', usage, this.firstInputTokens, cacheWrite);
        return;
      case 'model_context_window_exceeded':
        this.emitter.fail(CONTEXT_WINDOW_EXCEEDED, 'invalid_request', 'the model stopped because the conversation exceeded its context window');
        return;
      case 'refusal':
        this.emitter.incomplete('content_filter', usage, this.firstInputTokens, cacheWrite);
        return;
      default:
        throw new UpstreamProtocolError(`the upstream sent the unsupported stop_reason ${JSON.stringify(this.stopReason)}`);
    }
  }
}
