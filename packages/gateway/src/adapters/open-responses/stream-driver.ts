import type { StreamEvent } from '@momonga/protocol';
import { MalformedOutputError, StreamFailure, UNNAMED_UPSTREAM_FAILURE, UNSTATED_FAILURE_MESSAGE, UpstreamProtocolError } from '../shared/failures.ts';
import { MAX_TOOL_CALLS } from '../shared/limits.ts';
import type { ResponseEmitter } from '../shared/response-emitter.ts';
import type { ItemRef, OpenResponsesStreamEvent, UpstreamItem, UpstreamTerminal } from './events.ts';

type ItemState =
  | { kind: 'message'; streamedText: boolean; streamedRefusal: boolean }
  | { kind: 'function_call'; streamedArguments: boolean }
  | { kind: 'reasoning'; streamedContent: boolean; streamedSummary: boolean }
  | { kind: 'other' };

const itemName = (at: ItemRef): string => (at.outputIndex === undefined ? `output item ${JSON.stringify(at.itemId)}` : `output item ${at.outputIndex}`);

export class OpenResponsesStreamDriver {
  private readonly emitter: ResponseEmitter;
  private readonly items = new Map<number, ItemState>();
  private readonly slots = new Map<string, number>();
  private nextSlot = 0;
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

  async accept(event: OpenResponsesStreamEvent): Promise<StreamEvent[]> {
    if (this.emitter.terminated) return [];
    try {
      await this.apply(event);
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

  private async apply(event: OpenResponsesStreamEvent): Promise<void> {
    if (event.type === 'error') throw new StreamFailure(event.code ?? UNNAMED_UPSTREAM_FAILURE, event.errorType, event.message ?? UNSTATED_FAILURE_MESSAGE);
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
        this.addItem(event.at, event.item);
        return;
      case 'text_delta': {
        const state = this.messageAt(event.at);
        state.streamedText = true;
        this.emitter.appendText(event.delta);
        return;
      }
      case 'refusal_delta': {
        const state = this.messageAt(event.at);
        state.streamedRefusal = true;
        this.emitter.appendRefusal(event.delta);
        return;
      }
      case 'reasoning_delta': {
        const { slot, state } = this.reasoningAt(event.at);
        state.streamedContent = true;
        this.emitter.appendReasoning(slot, event.delta, event.contentIndex);
        return;
      }
      case 'reasoning_summary_delta': {
        const { slot, state } = this.reasoningAt(event.at);
        state.streamedSummary = true;
        this.emitter.appendReasoningSummary(slot, event.delta, event.summaryIndex);
        return;
      }
      case 'arguments_delta': {
        const { slot, state } = this.callAt(event.at);
        state.streamedArguments = true;
        this.emitter.appendCallArguments(slot, event.delta);
        return;
      }
      case 'item_done':
        this.finishItem(event.at, event.item);
        return;
      case 'terminal':
        await this.conclude(event.terminal);
        return;
    }
  }

  private keysOf(at: ItemRef): string[] {
    return [...(at.outputIndex === undefined ? [] : [`index:${at.outputIndex}`]), ...(at.itemId === undefined ? [] : [`id:${at.itemId}`])];
  }

  private slotOf(at: ItemRef): number | undefined {
    for (const key of this.keysOf(at)) {
      const slot = this.slots.get(key);
      if (slot !== undefined) return slot;
    }
    return undefined;
  }

  private addItem(at: ItemRef, item: UpstreamItem): void {
    const named = itemName(at);
    if (this.slotOf(at) !== undefined) throw new UpstreamProtocolError(`the upstream added ${named} twice`);
    const slot = this.nextSlot;
    this.nextSlot += 1;
    for (const key of this.keysOf(at)) this.slots.set(key, slot);
    if (item.kind === 'message') {
      this.items.set(slot, { kind: 'message', streamedText: false, streamedRefusal: false });
      return;
    }
    if (item.kind === 'function_call') {
      if (this.emitter.callCount >= MAX_TOOL_CALLS) throw new UpstreamProtocolError(`the upstream sent more than ${MAX_TOOL_CALLS} tool calls`);
      if (item.callId === '' || item.name === '') throw new UpstreamProtocolError(`function_call ${named} lacks a call_id or a name`);
      const state: ItemState = { kind: 'function_call', streamedArguments: item.arguments !== '' };
      this.items.set(slot, state);
      this.emitter.beginCall(slot, item.callId, item.name);
      if (item.arguments !== '') this.emitter.appendCallArguments(slot, item.arguments);
      return;
    }
    if (item.kind === 'reasoning') {
      this.items.set(slot, { kind: 'reasoning', streamedContent: false, streamedSummary: false });
      this.emitter.beginReasoning(slot);
      return;
    }
    this.items.set(slot, { kind: 'other' });
  }

  private stateAt(at: ItemRef): { slot: number; state: ItemState | undefined } | undefined {
    const slot = this.slotOf(at);
    return slot === undefined ? undefined : { slot, state: this.items.get(slot) };
  }

  private reasoningAt(at: ItemRef): { slot: number; state: Extract<ItemState, { kind: 'reasoning' }> } {
    const found = this.stateAt(at);
    if (found?.state?.kind !== 'reasoning') {
      throw new UpstreamProtocolError(`the upstream sent a reasoning delta for ${itemName(at)}, which is not an open reasoning item`);
    }
    return { slot: found.slot, state: found.state };
  }

  private messageAt(at: ItemRef): Extract<ItemState, { kind: 'message' }> {
    const found = this.stateAt(at);
    if (found?.state?.kind !== 'message') throw new UpstreamProtocolError(`the upstream sent a text delta for ${itemName(at)}, which is not an open message`);
    return found.state;
  }

  private callAt(at: ItemRef): { slot: number; state: Extract<ItemState, { kind: 'function_call' }> } {
    const found = this.stateAt(at);
    if (found?.state?.kind !== 'function_call') {
      throw new UpstreamProtocolError(`the upstream sent argument deltas for ${itemName(at)}, which is not an open function_call`);
    }
    return { slot: found.slot, state: found.state };
  }

  private finishItem(at: ItemRef, item: UpstreamItem): void {
    const found = this.stateAt(at);
    const state = found?.state;
    if (found === undefined || state === undefined) throw new UpstreamProtocolError(`the upstream finished the unopened ${itemName(at)}`);
    const { slot } = found;
    if (state.kind === 'message' && item.kind === 'message') {
      if (!state.streamedText && item.text !== '') this.emitter.appendText(item.text);
      if (!state.streamedRefusal && item.refusal !== '') this.emitter.appendRefusal(item.refusal);
      return;
    }
    if (state.kind === 'function_call' && item.kind === 'function_call') {
      if (!state.streamedArguments && item.arguments !== '') this.emitter.appendCallArguments(slot, item.arguments);
      return;
    }
    if (state.kind === 'reasoning' && item.kind === 'reasoning') {
      if (!state.streamedContent) item.content.forEach((text, index) => this.emitter.appendReasoning(slot, text, index));
      if (!state.streamedSummary) item.summary.forEach((text, index) => this.emitter.appendReasoningSummary(slot, text, index));
      if (item.encryptedContent !== undefined) this.emitter.annotateReasoning(slot, { encryptedContent: item.encryptedContent });
      this.emitter.completeReasoning(slot);
      return;
    }
    if (state.kind !== 'other' || item.kind !== 'other') {
      throw new UpstreamProtocolError(`the upstream finished ${itemName(at)} as a different type than it opened`);
    }
  }

  private async conclude(terminal: UpstreamTerminal): Promise<void> {
    if (terminal.status === 'completed') {
      await this.emitter.complete(terminal.usage);
      return;
    }
    if (terminal.status === 'failed') {
      this.emitter.fail(terminal.code ?? UNNAMED_UPSTREAM_FAILURE, terminal.errorType, terminal.message ?? UNSTATED_FAILURE_MESSAGE);
      return;
    }
    if (terminal.reason === 'max_output_tokens' || terminal.reason === 'content_filter') {
      this.emitter.incomplete(terminal.reason, terminal.usage);
      return;
    }
    throw new UpstreamProtocolError(`the upstream ended the response as incomplete for the unsupported reason ${JSON.stringify(terminal.reason)}`);
  }
}
