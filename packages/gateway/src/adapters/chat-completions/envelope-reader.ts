import { canonicalJson } from '@momonga/foundation';
import { MalformedOutputError } from '../shared/failures.ts';
import type { JsonEvent } from './incremental-json.ts';
import { ValueBuilder } from './value-builder.ts';

export type EnvelopeHandlers = {
  finalTextStarted(): void;
  finalTextDelta(text: string): void;
  toolCall(call: { name: string; argumentsJson: string }): void;
};

type Phase =
  | 'start'
  | 'top-key'
  | 'kind-value'
  | 'text-value'
  | 'calls-value'
  | 'calls-elements'
  | 'call-element'
  | 'top-end';

const MAX_KIND_CHARS = 32;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class EnvelopeReader {
  private readonly toolNames: ReadonlySet<string>;
  private readonly handlers: EnvelopeHandlers;
  private readonly requireToolCalls: boolean;
  private phase: Phase = 'start';
  private kind: 'final' | 'tool_calls' | undefined;
  private kindText = '';
  private textFinished = false;
  private callsFinished = false;
  private callCount = 0;
  private builder: ValueBuilder | undefined;
  private closed = false;

  constructor(toolNames: ReadonlySet<string>, handlers: EnvelopeHandlers, requireToolCalls: boolean) {
    this.toolNames = toolNames;
    this.requireToolCalls = requireToolCalls;
    this.handlers = handlers;
  }

  accept(event: JsonEvent): void {
    switch (this.phase) {
      case 'start':
        if (event.type !== 'object-start') throw new MalformedOutputError('the model reply is not a JSON object');
        this.phase = 'top-key';
        return;
      case 'top-key':
        this.acceptTopKey(event);
        return;
      case 'kind-value':
        this.acceptKind(event);
        return;
      case 'text-value':
        this.acceptText(event);
        return;
      case 'calls-value':
        if (event.type !== 'array-start') throw new MalformedOutputError('"calls" must be an array');
        this.phase = 'calls-elements';
        return;
      case 'calls-elements':
        this.acceptCallsElement(event);
        return;
      case 'call-element':
        this.acceptCallElement(event);
        return;
      case 'top-end':
        throw new MalformedOutputError('unexpected content after the reply object');
    }
  }

  finish(): void {
    if (!this.closed) throw new MalformedOutputError('the model reply ended before the JSON object was complete');
    if (this.kind === 'final' && !this.textFinished) throw new MalformedOutputError('the final reply has no "text"');
    if (this.kind === 'tool_calls' && this.callCount === 0) throw new MalformedOutputError('the tool_calls reply has no calls');
  }

  private acceptTopKey(event: JsonEvent): void {
    if (event.type === 'object-end') {
      this.closed = true;
      this.phase = 'top-end';
      return;
    }
    if (event.type !== 'key') throw new MalformedOutputError('unexpected value in the reply object');
    const { key } = event;
    if (this.kind === undefined) {
      if (key !== 'kind') throw new MalformedOutputError('"kind" must be the first field of the reply object');
      this.phase = 'kind-value';
    } else if (key === 'text' && this.kind === 'final' && !this.textFinished) {
      this.phase = 'text-value';
    } else if (key === 'calls' && this.kind === 'tool_calls' && !this.callsFinished) {
      this.phase = 'calls-value';
    } else throw new MalformedOutputError(`unexpected field ${JSON.stringify(key)} in a ${this.kind} reply`);
  }

  private acceptKind(event: JsonEvent): void {
    if (event.type === 'string-start') {
      this.kindText = '';
      return;
    }
    if (event.type === 'string-delta') {
      this.kindText += event.text;
      if (this.kindText.length > MAX_KIND_CHARS) throw new MalformedOutputError('"kind" is not a recognised value');
      return;
    }
    if (event.type !== 'string-end') throw new MalformedOutputError('"kind" must be a string');
    if (this.kindText !== 'final' && this.kindText !== 'tool_calls') {
      throw new MalformedOutputError(`"kind" must be "final" or "tool_calls", got ${JSON.stringify(this.kindText)}`);
    }
    if (this.kindText === 'final' && this.requireToolCalls) {
      throw new MalformedOutputError('the model answered directly although a tool call was required');
    }
    this.kind = this.kindText;
    this.phase = 'top-key';
  }

  private acceptText(event: JsonEvent): void {
    if (event.type === 'string-start') {
      this.handlers.finalTextStarted();
    } else if (event.type === 'string-delta') {
      this.handlers.finalTextDelta(event.text);
    } else if (event.type === 'string-end') {
      this.textFinished = true;
      this.phase = 'top-key';
    } else throw new MalformedOutputError('"text" must be a string');
  }

  private acceptCallsElement(event: JsonEvent): void {
    if (event.type === 'array-end') {
      this.callsFinished = true;
      this.phase = 'top-key';
      return;
    }
    if (event.type !== 'object-start') throw new MalformedOutputError('each element of "calls" must be an object');
    this.builder = new ValueBuilder();
    this.builder.accept(event);
    this.phase = 'call-element';
  }

  private acceptCallElement(event: JsonEvent): void {
    const builder = this.builder;
    if (builder === undefined) throw new Error('the call element builder is missing');
    builder.accept(event);
    if (!builder.done) return;
    this.builder = undefined;
    this.phase = 'calls-elements';
    this.emitCall(builder.value);
  }

  private emitCall(value: unknown): void {
    if (!isRecord(value)) throw new MalformedOutputError('a call must be an object');
    const keys = Object.keys(value);
    const { name } = value;
    const args = value['arguments'];
    if (keys.length !== 2 || typeof name !== 'string' || !isRecord(args)) {
      throw new MalformedOutputError('a call must have exactly a string "name" and an object "arguments"');
    }
    if (!this.toolNames.has(name)) throw new MalformedOutputError(`the model called the undeclared tool ${JSON.stringify(name)}`);
    this.callCount += 1;
    this.handlers.toolCall({ name, argumentsJson: canonicalJson(args) });
  }
}
