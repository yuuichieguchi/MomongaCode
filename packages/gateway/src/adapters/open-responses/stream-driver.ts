import type { StreamEvent } from '@momonga/protocol';
import { MalformedOutputError, StreamFailure, UpstreamProtocolError } from '../shared/failures.ts';
import { MAX_TOOL_CALLS } from '../shared/limits.ts';
import type { ResponseEmitter } from '../shared/response-emitter.ts';
import type { OpenResponsesStreamEvent, UpstreamItem, UpstreamTerminal } from './events.ts';

type ItemState =
  | { kind: 'message'; streamedText: boolean; streamedRefusal: boolean }
  | { kind: 'function_call'; streamedArguments: boolean }
  | { kind: 'reasoning'; streamedContent: boolean; streamedSummary: boolean }
  | { kind: 'other' };

export class OpenResponsesStreamDriver {
  private readonly emitter: ResponseEmitter;
  private readonly items = new Map<number, ItemState>();
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

  accept(event: OpenResponsesStreamEvent): StreamEvent[] {
    if (this.emitter.terminated) return [];
    try {
      this.apply(event);
    } catch (error) {
      if (!this.started || !(error instanceof UpstreamProtocolError || error instanceof MalformedOutputError)) throw error;
      this.emitter.fail(error.code, error.errorType, error.message);
    }
    return this.emitter.take();
  }

  end(): StreamEvent[] {
    if (this.emitter.terminated) return this.emitter.take();
    const failure = new UpstreamProtocolError('the upstream stream ended without a terminal response event');
    if (!this.started) throw failure;
    return this.fail(failure);
  }

  fail(failure: UpstreamProtocolError): StreamEvent[] {
    if (!this.emitter.terminated) this.emitter.fail(failure.code, failure.errorType, failure.message);
    return this.emitter.take();
  }

  private apply(event: OpenResponsesStreamEvent): void {
    if (event.type === 'error') throw new StreamFailure(event.code, event.errorType, event.message);
    if (event.type === 'ignored') return;
    if (!this.started) {
      if (event.type !== 'opening') throw new UpstreamProtocolError(`the upstream sent ${event.type} before response.created`);
      this.started = true;
      this.emitter.start();
      return;
    }
    switch (event.type) {
      case 'opening':
        return;
      case 'item_added':
        this.addItem(event.outputIndex, event.item);
        return;
      case 'text_delta': {
        const state = this.messageAt(event.outputIndex);
        state.streamedText = true;
        this.emitter.appendText(event.delta);
        return;
      }
      case 'refusal_delta': {
        const state = this.messageAt(event.outputIndex);
        state.streamedRefusal = true;
        this.emitter.appendRefusal(event.delta);
        return;
      }
      case 'reasoning_delta': {
        const state = this.reasoningAt(event.outputIndex);
        state.streamedContent = true;
        this.emitter.appendReasoning(event.outputIndex, event.delta, event.contentIndex);
        return;
      }
      case 'reasoning_summary_delta': {
        const state = this.reasoningAt(event.outputIndex);
        state.streamedSummary = true;
        this.emitter.appendReasoningSummary(event.outputIndex, event.delta, event.summaryIndex);
        return;
      }
      case 'arguments_delta': {
        const state = this.callAt(event.outputIndex);
        state.streamedArguments = true;
        this.emitter.appendCallArguments(event.outputIndex, event.delta);
        return;
      }
      case 'item_done':
        this.finishItem(event.outputIndex, event.item);
        return;
      case 'terminal':
        this.conclude(event.terminal);
        return;
    }
  }

  private addItem(outputIndex: number, item: UpstreamItem): void {
    if (this.items.has(outputIndex)) throw new UpstreamProtocolError(`the upstream added output item ${outputIndex} twice`);
    if (item.kind === 'message') {
      this.items.set(outputIndex, { kind: 'message', streamedText: false, streamedRefusal: false });
      return;
    }
    if (item.kind === 'function_call') {
      if (this.emitter.callCount >= MAX_TOOL_CALLS) throw new UpstreamProtocolError(`the upstream sent more than ${MAX_TOOL_CALLS} tool calls`);
      if (item.callId === '' || item.name === '') throw new UpstreamProtocolError(`function_call item ${outputIndex} lacks a call_id or a name`);
      const state: ItemState = { kind: 'function_call', streamedArguments: item.arguments !== '' };
      this.items.set(outputIndex, state);
      this.emitter.beginCall(outputIndex, item.callId, item.name);
      if (item.arguments !== '') this.emitter.appendCallArguments(outputIndex, item.arguments);
      return;
    }
    if (item.kind === 'reasoning') {
      this.items.set(outputIndex, { kind: 'reasoning', streamedContent: false, streamedSummary: false });
      this.emitter.beginReasoning(outputIndex);
      return;
    }
    this.items.set(outputIndex, { kind: 'other' });
  }

  private reasoningAt(outputIndex: number): Extract<ItemState, { kind: 'reasoning' }> {
    const state = this.items.get(outputIndex);
    if (state?.kind !== 'reasoning') {
      throw new UpstreamProtocolError(`the upstream sent a reasoning delta for output item ${outputIndex}, which is not an open reasoning item`);
    }
    return state;
  }

  private messageAt(outputIndex: number): Extract<ItemState, { kind: 'message' }> {
    const state = this.items.get(outputIndex);
    if (state?.kind !== 'message') throw new UpstreamProtocolError(`the upstream sent a text delta for output item ${outputIndex}, which is not an open message`);
    return state;
  }

  private callAt(outputIndex: number): Extract<ItemState, { kind: 'function_call' }> {
    const state = this.items.get(outputIndex);
    if (state?.kind !== 'function_call') {
      throw new UpstreamProtocolError(`the upstream sent argument deltas for output item ${outputIndex}, which is not an open function_call`);
    }
    return state;
  }

  private finishItem(outputIndex: number, item: UpstreamItem): void {
    const state = this.items.get(outputIndex);
    if (state === undefined) throw new UpstreamProtocolError(`the upstream finished the unopened output item ${outputIndex}`);
    if (state.kind === 'message' && item.kind === 'message') {
      if (!state.streamedText && item.text !== '') this.emitter.appendText(item.text);
      if (!state.streamedRefusal && item.refusal !== '') this.emitter.appendRefusal(item.refusal);
      return;
    }
    if (state.kind === 'function_call' && item.kind === 'function_call') {
      if (!state.streamedArguments && item.arguments !== '') this.emitter.appendCallArguments(outputIndex, item.arguments);
      return;
    }
    if (state.kind === 'reasoning' && item.kind === 'reasoning') {
      if (!state.streamedContent) item.content.forEach((text, index) => this.emitter.appendReasoning(outputIndex, text, index));
      if (!state.streamedSummary) item.summary.forEach((text, index) => this.emitter.appendReasoningSummary(outputIndex, text, index));
      if (item.encryptedContent !== undefined) this.emitter.annotateReasoning(outputIndex, { encryptedContent: item.encryptedContent });
      this.emitter.completeReasoning(outputIndex);
      return;
    }
    if (state.kind !== 'other' || item.kind !== 'other') {
      throw new UpstreamProtocolError(`the upstream finished output item ${outputIndex} as a different type than it opened`);
    }
  }

  private conclude(terminal: UpstreamTerminal): void {
    if (terminal.status === 'completed') {
      this.emitter.complete(terminal.usage);
      return;
    }
    if (terminal.status === 'failed') {
      this.emitter.fail(terminal.code, terminal.errorType, terminal.message);
      return;
    }
    if (terminal.reason === 'max_output_tokens' || terminal.reason === 'content_filter') {
      this.emitter.incomplete(terminal.reason, terminal.usage);
      return;
    }
    throw new UpstreamProtocolError(`the upstream ended the response as incomplete for the unsupported reason ${JSON.stringify(terminal.reason)}`);
  }
}
