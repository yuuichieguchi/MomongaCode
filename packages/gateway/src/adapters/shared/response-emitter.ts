import { uuidv7 } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import type {
  AdapterRequest,
  ErrorType,
  FunctionCallItem,
  ItemField,
  ItemStatus,
  MessageItem,
  ContentPart,
  ResponseResource,
  StreamEvent,
  Usage,
} from '@momonga/protocol';
import { echoedTools } from '../../core/resource.ts';
import { MAX_CALL_ARGUMENT_CHARS, MAX_RESPONSE_TEXT_CHARS } from './limits.ts';
import { UpstreamProtocolError } from './failures.ts';

type Unsequenced<Event> = Event extends unknown ? Omit<Event, 'sequence_number'> : never;

type MessagePart = { kind: 'text' | 'refusal'; text: string };
type OpenMessage = { kind: 'message'; id: string; outputIndex: number; parts: MessagePart[] };
type OpenCall = { kind: 'call'; id: string; outputIndex: number; callId: string; name: string; args: string };
type OpenItem = OpenMessage | OpenCall;

export type ResponseEmitterOptions = {
  clock: Clock;
  model: string;
  request: AdapterRequest;
};

const newId = (prefix: string, clock: Clock): string => `${prefix}_${uuidv7(clock).replaceAll('-', '')}`;

const contextHint = (contextInputTokens: number | undefined): { contextInputTokens?: number } =>
  contextInputTokens === undefined ? {} : { contextInputTokens };

const cacheWriteHint = (cacheWriteInputTokens: number | undefined): { cacheWriteInputTokens?: number } =>
  cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens };

export class ResponseEmitter {
  private readonly options: ResponseEmitterOptions;
  private readonly responseId: string;
  private readonly createdAtSeconds: number;
  private readonly open = new Map<number, OpenItem>();
  private readonly callIndexByKey = new Map<number, number>();
  private readonly doneItems: ItemField[] = [];
  private pending: StreamEvent[] = [];
  private sequence = 0;
  private nextOutputIndex = 0;
  private message: OpenMessage | undefined;
  private textChars = 0;
  private ended = false;

  constructor(options: ResponseEmitterOptions) {
    this.options = options;
    this.responseId = newId('resp', options.clock);
    this.createdAtSeconds = Math.floor(options.clock.now() / 1000);
  }

  get terminated(): boolean {
    return this.ended;
  }

  take(): StreamEvent[] {
    const events = this.pending;
    this.pending = [];
    return events;
  }

  start(): void {
    const response = this.resource({ status: 'in_progress', output: [], usage: null });
    this.emit({ type: 'response.created', response });
    this.emit({ type: 'response.in_progress', response });
  }

  openMessage(): void {
    this.partOf('text');
  }

  appendText(delta: string): void {
    this.append('text', delta);
  }

  appendRefusal(delta: string): void {
    this.append('refusal', delta);
  }

  private append(kind: MessagePart['kind'], delta: string): void {
    if (delta === '') return;
    this.textChars += delta.length;
    if (this.textChars > MAX_RESPONSE_TEXT_CHARS) {
      throw new UpstreamProtocolError(`the response text exceeds ${MAX_RESPONSE_TEXT_CHARS} characters`);
    }
    const { message, index } = this.partOf(kind);
    (message.parts[index] as MessagePart).text += delta;
    const base = { item_id: message.id, output_index: message.outputIndex, content_index: index, delta };
    this.emit(kind === 'text' ? { type: 'response.output_text.delta', ...base } : { type: 'response.refusal.delta', ...base });
  }

  private partOf(kind: MessagePart['kind']): { message: OpenMessage; index: number } {
    let message = this.message;
    if (message === undefined) {
      message = { kind: 'message', id: newId('msg', this.options.clock), outputIndex: this.allocate(), parts: [] };
      this.message = message;
      this.open.set(message.outputIndex, message);
      this.emit({
        type: 'response.output_item.added',
        output_index: message.outputIndex,
        item: { type: 'message', id: message.id, status: 'in_progress', role: 'assistant', content: [] },
      });
    }
    let index = message.parts.findIndex((part) => part.kind === kind);
    if (index < 0) {
      index = message.parts.length;
      message.parts.push({ kind, text: '' });
      this.emit({
        type: 'response.content_part.added',
        item_id: message.id,
        output_index: message.outputIndex,
        content_index: index,
        part: this.contentPartOf(message.parts[index] as MessagePart),
      });
    }
    return { message, index };
  }

  hasCall(key: number): boolean {
    return this.callIndexByKey.has(key);
  }

  get callCount(): number {
    return this.callIndexByKey.size;
  }

  beginCall(key: number, callId: string, name: string): void {
    const call: OpenCall = { kind: 'call', id: newId('fc', this.options.clock), outputIndex: this.allocate(), callId, name, args: '' };
    this.callIndexByKey.set(key, call.outputIndex);
    this.open.set(call.outputIndex, call);
    this.emit({ type: 'response.output_item.added', output_index: call.outputIndex, item: this.callItem(call, 'in_progress') });
  }

  callName(key: number): string {
    return this.callOf(key).name;
  }

  appendCallArguments(key: number, delta: string): void {
    if (delta === '') return;
    const call = this.callOf(key);
    if (call.args.length + delta.length > MAX_CALL_ARGUMENT_CHARS) {
      throw new UpstreamProtocolError(`the arguments of tool call "${call.name}" exceed ${MAX_CALL_ARGUMENT_CHARS} characters`);
    }
    call.args += delta;
    this.emit({ type: 'response.function_call_arguments.delta', item_id: call.id, output_index: call.outputIndex, delta });
  }

  completeCall(key: number): void {
    this.closeItem(this.callOf(key), 'completed');
  }

  complete(usage: Usage | undefined, contextInputTokens?: number, cacheWriteInputTokens?: number): void {
    this.closeOpenItems('completed');
    this.emit({
      type: 'response.completed',
      response: {
        ...this.resource({ status: 'completed', output: this.doneItems, usage: usage ?? null }),
        ...contextHint(contextInputTokens),
        ...cacheWriteHint(cacheWriteInputTokens),
      },
    });
    this.ended = true;
  }

  incomplete(reason: 'max_output_tokens' | 'content_filter', usage: Usage | undefined, contextInputTokens?: number, cacheWriteInputTokens?: number): void {
    this.closeOpenItems('incomplete');
    this.emit({
      type: 'response.incomplete',
      response: {
        ...this.resource({ status: 'incomplete', output: this.doneItems, usage: usage ?? null }),
        incomplete_details: { reason },
        ...contextHint(contextInputTokens),
        ...cacheWriteHint(cacheWriteInputTokens),
      },
    });
    this.ended = true;
  }

  fail(code: string, errorType: ErrorType, message: string): void {
    this.closeOpenItems('incomplete');
    this.emit({
      type: 'response.failed',
      response: {
        ...this.resource({ status: 'failed', output: this.doneItems, usage: null }),
        error: { code, message, type: errorType },
      },
    });
    this.ended = true;
  }

  private allocate(): number {
    const index = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    return index;
  }

  private callOf(key: number): OpenCall {
    const outputIndex = this.callIndexByKey.get(key);
    const call = outputIndex === undefined ? undefined : this.open.get(outputIndex);
    if (call?.kind !== 'call') throw new Error(`tool call ${key} is not open`);
    return call;
  }

  private closeOpenItems(status: ItemStatus): void {
    const items = [...this.open.values()].sort((left, right) => left.outputIndex - right.outputIndex);
    for (const item of items) this.closeItem(item, status);
  }

  private closeItem(item: OpenItem, status: ItemStatus): void {
    this.open.delete(item.outputIndex);
    if (item.kind === 'call') {
      this.emit({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: item.outputIndex, arguments: item.args });
      const done = this.callItem(item, status);
      this.doneItems.push(done);
      this.emit({ type: 'response.output_item.done', output_index: item.outputIndex, item: done });
      return;
    }
    item.parts.forEach((part, index) => {
      const base = { item_id: item.id, output_index: item.outputIndex, content_index: index };
      this.emit(
        part.kind === 'text'
          ? { type: 'response.output_text.done', ...base, text: part.text }
          : { type: 'response.refusal.done', ...base, refusal: part.text },
      );
      this.emit({ type: 'response.content_part.done', ...base, part: this.contentPartOf(part) });
    });
    const done: MessageItem = {
      type: 'message',
      id: item.id,
      status,
      role: 'assistant',
      content: item.parts.map((part) => this.contentPartOf(part)),
    };
    this.doneItems.push(done);
    this.emit({ type: 'response.output_item.done', output_index: item.outputIndex, item: done });
  }

  private contentPartOf(part: MessagePart): ContentPart {
    return part.kind === 'text' ? { type: 'output_text', text: part.text, annotations: [] } : { type: 'refusal', refusal: part.text };
  }

  private callItem(call: OpenCall, status: ItemStatus): FunctionCallItem {
    return { type: 'function_call', id: call.id, call_id: call.callId, name: call.name, arguments: call.args, status };
  }

  private emit(event: Unsequenced<StreamEvent>): void {
    this.pending.push({ ...event, sequence_number: this.sequence } as StreamEvent);
    this.sequence += 1;
  }

  private resource(state: { status: ResponseResource['status']; output: ItemField[]; usage: Usage | null }): ResponseResource {
    const { request } = this.options;
    const terminal = state.status !== 'in_progress';
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAtSeconds,
      completed_at: terminal ? Math.floor(this.options.clock.now() / 1000) : null,
      status: state.status,
      incomplete_details: null,
      model: this.options.model,
      previous_response_id: null,
      instructions: request.instructions ?? null,
      output: [...state.output],
      error: null,
      tools: echoedTools(request.tools),
      tool_choice: request.tool_choice ?? 'auto',
      truncation: 'disabled',
      parallel_tool_calls: request.parallel_tool_calls ?? false,
      text: { format: { type: 'text' } },
      top_p: request.top_p ?? 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_logprobs: 0,
      temperature: request.temperature ?? 1,
      reasoning: null,
      usage: state.usage,
      max_output_tokens: request.max_output_tokens ?? null,
      max_tool_calls: null,
      store: false,
      background: false,
      service_tier: 'default',
      metadata: {},
      safety_identifier: null,
      prompt_cache_key: null,
    };
  }
}
