import type { ChatReasoningField, StreamEvent, Usage } from '@momonga/protocol';
import { StreamFailure, UpstreamProtocolError } from '../shared/failures.ts';
import type { ResponseEmitter } from '../shared/response-emitter.ts';
import { parseUpstreamChunk } from './upstream-chunk.ts';
import type { ToolCallFragment } from './upstream-chunk.ts';

export type ContentSink = {
  text(text: string): Promise<void>;
  toolCall(fragment: ToolCallFragment): void;
  finish(outcome: 'complete' | 'truncated'): Promise<void>;
};

export class StreamDriver {
  private readonly emitter: ResponseEmitter;
  private readonly sink: ContentSink;
  private finishReason: string | undefined;
  private usage: Usage | undefined;
  private reasoningField: ChatReasoningField | undefined;

  constructor(emitter: ResponseEmitter, sink: ContentSink) {
    this.emitter = emitter;
    this.sink = sink;
  }

  get terminated(): boolean {
    return this.emitter.terminated;
  }

  start(): StreamEvent[] {
    this.emitter.start();
    return this.emitter.take();
  }

  async accept(data: string): Promise<StreamEvent[]> {
    if (this.emitter.terminated) return [];
    try {
      await this.apply(data);
    } catch (error) {
      this.failWith(error);
    }
    return this.emitter.take();
  }

  async end(): Promise<StreamEvent[]> {
    if (this.emitter.terminated) return this.emitter.take();
    try {
      await this.conclude();
    } catch (error) {
      this.failWith(error);
    }
    return this.emitter.take();
  }

  fail(failure: StreamFailure): StreamEvent[] {
    if (!this.emitter.terminated) this.emitter.fail(failure.code, failure.errorType, failure.message);
    return this.emitter.take();
  }

  private failWith(error: unknown): void {
    if (!(error instanceof StreamFailure)) throw error;
    this.emitter.fail(error.code, error.errorType, error.message);
  }

  private async apply(data: string): Promise<void> {
    const chunk = parseUpstreamChunk(data);
    const hasContent =
      chunk.reasoning !== undefined ||
      (chunk.content !== undefined && chunk.content !== '') ||
      (chunk.refusal !== undefined && chunk.refusal !== '') ||
      chunk.toolCalls.length > 0;
    if (this.finishReason !== undefined && (hasContent || chunk.finishReason !== undefined)) {
      throw new UpstreamProtocolError('the upstream sent content after the finish_reason');
    }
    if (chunk.reasoning !== undefined) this.acceptReasoning(chunk.reasoning.field, chunk.reasoning.text);
    if (chunk.content !== undefined && chunk.content !== '') {
      this.reasoningField = undefined;
      await this.sink.text(chunk.content);
    }
    if (chunk.refusal !== undefined && chunk.refusal !== '') this.emitter.appendRefusal(chunk.refusal);
    if (chunk.toolCalls.length > 0) this.reasoningField = undefined;
    for (const fragment of chunk.toolCalls) this.sink.toolCall(fragment);
    if (chunk.finishReason !== undefined) this.finishReason = chunk.finishReason;
    if (chunk.usage !== undefined) this.usage = chunk.usage;
    if (chunk.promptProgress) this.emitter.noteProgress();
  }

  private acceptReasoning(field: ChatReasoningField, text: string): void {
    if (this.reasoningField !== undefined && this.reasoningField !== field) {
      throw new UpstreamProtocolError(`the upstream sent reasoning in ${field} after sending it in ${this.reasoningField}`);
    }
    this.reasoningField = field;
    this.emitter.streamReasoning(text, field);
  }

  private async conclude(): Promise<void> {
    switch (this.finishReason) {
      case undefined:
        throw new UpstreamProtocolError('the upstream stream ended without a finish_reason');
      case 'stop':
      case 'tool_calls':
        await this.sink.finish('complete');
        await this.emitter.complete(this.usage);
        return;
      case 'length':
        await this.sink.finish('truncated');
        this.emitter.incomplete('max_output_tokens', this.usage);
        return;
      case 'content_filter':
        await this.sink.finish('truncated');
        this.emitter.incomplete('content_filter', this.usage);
        return;
      default:
        throw new UpstreamProtocolError(`the upstream sent the unsupported finish_reason ${JSON.stringify(this.finishReason)}`);
    }
  }
}
