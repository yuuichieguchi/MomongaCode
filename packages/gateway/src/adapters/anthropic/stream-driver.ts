import type { StreamEvent, Usage } from '@momonga/protocol';
import { UpstreamProtocolError } from '../shared/failures.ts';
import { MAX_TOOL_CALLS } from '../shared/limits.ts';
import type { ResponseEmitter } from '../shared/response-emitter.ts';
import type { AnthropicStreamEvent, AnthropicUsageFields } from './events.ts';
import { streamErrorOf } from './errors.ts';

type BlockState = { kind: 'text' } | { kind: 'tool'; receivedArguments: boolean } | { kind: 'ignored' };

const EMPTY_ARGUMENTS = '{}';

const usageOf = (fields: AnthropicUsageFields): Usage | undefined => {
  if (Object.keys(fields).length === 0) return undefined;
  const input = (fields.input_tokens ?? 0) + (fields.cache_creation_input_tokens ?? 0) + (fields.cache_read_input_tokens ?? 0);
  const output = fields.output_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: fields.cache_read_input_tokens ?? 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
};

export class AnthropicStreamDriver {
  private readonly emitter: ResponseEmitter;
  private readonly blocks = new Map<number, BlockState>();
  private usage: AnthropicUsageFields = {};
  private stopReason: string | undefined;
  private started = false;

  constructor(emitter: ResponseEmitter) {
    this.emitter = emitter;
  }

  get hasStarted(): boolean {
    return this.started;
  }

  get terminated(): boolean {
    return this.emitter.terminated;
  }

  accept(event: AnthropicStreamEvent): StreamEvent[] {
    if (this.emitter.terminated) return [];
    try {
      this.apply(event);
    } catch (error) {
      if (!this.started || !(error instanceof UpstreamProtocolError)) throw error;
      this.emitter.fail(error.code, error.errorType, error.message);
    }
    return this.emitter.take();
  }

  end(): StreamEvent[] {
    if (this.emitter.terminated) return this.emitter.take();
    const failure = new UpstreamProtocolError('the upstream stream ended without a message_stop event');
    if (!this.started) throw failure;
    return this.fail(failure);
  }

  fail(failure: UpstreamProtocolError): StreamEvent[] {
    if (!this.emitter.terminated) this.emitter.fail(failure.code, failure.errorType, failure.message);
    return this.emitter.take();
  }

  private apply(event: AnthropicStreamEvent): void {
    if (event.type === 'error') throw streamErrorOf(event.errorType, event.message);
    if (!this.started) {
      if (event.type === 'ping' || event.type === 'unknown') return;
      if (event.type !== 'message_start') throw new UpstreamProtocolError(`the upstream sent ${event.type} before message_start`);
      this.started = true;
      this.usage = { ...event.usage };
      this.emitter.start();
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
        this.usage = { ...this.usage, ...event.usage };
        return;
      case 'message_stop':
        this.conclude();
        return;
    }
  }

  private startBlock(event: Extract<AnthropicStreamEvent, { type: 'content_block_start' }>): void {
    if (this.blocks.has(event.index)) throw new UpstreamProtocolError(`the upstream started content block ${event.index} twice`);
    const { block } = event;
    if (block.kind === 'text') {
      this.blocks.set(event.index, { kind: 'text' });
      if (block.text !== '') this.emitter.appendText(block.text);
      return;
    }
    if (block.kind === 'tool_use') {
      if (this.emitter.callCount >= MAX_TOOL_CALLS) throw new UpstreamProtocolError(`the upstream sent more than ${MAX_TOOL_CALLS} tool calls`);
      if (block.id === '' || block.name === '') throw new UpstreamProtocolError(`tool_use block ${event.index} lacks an id or a name`);
      this.blocks.set(event.index, { kind: 'tool', receivedArguments: false });
      this.emitter.beginCall(event.index, block.id, block.name);
      return;
    }
    this.blocks.set(event.index, { kind: 'ignored' });
  }

  private applyDelta(event: Extract<AnthropicStreamEvent, { type: 'content_block_delta' }>): void {
    const block = this.blocks.get(event.index);
    if (block === undefined) throw new UpstreamProtocolError(`the upstream sent a delta for the unopened content block ${event.index}`);
    const { delta } = event;
    if (delta.kind === 'other' || block.kind === 'ignored') return;
    if (delta.kind === 'text') {
      if (block.kind !== 'text') throw new UpstreamProtocolError(`a text delta arrived for the tool_use block ${event.index}`);
      this.emitter.appendText(delta.text);
      return;
    }
    if (block.kind !== 'tool') throw new UpstreamProtocolError(`an input_json delta arrived for the text block ${event.index}`);
    if (delta.partialJson !== '') block.receivedArguments = true;
    this.emitter.appendCallArguments(event.index, delta.partialJson);
  }

  private stopBlock(index: number): void {
    const block = this.blocks.get(index);
    if (block === undefined) throw new UpstreamProtocolError(`the upstream stopped the unopened content block ${index}`);
    if (block.kind === 'tool' && !block.receivedArguments) this.emitter.appendCallArguments(index, EMPTY_ARGUMENTS);
  }

  private conclude(): void {
    const usage = usageOf(this.usage);
    switch (this.stopReason) {
      case undefined:
        throw new UpstreamProtocolError('the upstream sent message_stop without a stop_reason');
      case 'end_turn':
      case 'stop_sequence':
      case 'tool_use':
        this.emitter.complete(usage);
        return;
      case 'max_tokens':
      case 'model_context_window_exceeded':
        this.emitter.incomplete('max_output_tokens', usage);
        return;
      case 'refusal':
        this.emitter.incomplete('content_filter', usage);
        return;
      default:
        throw new UpstreamProtocolError(`the upstream sent the unsupported stop_reason ${JSON.stringify(this.stopReason)}`);
    }
  }
}
