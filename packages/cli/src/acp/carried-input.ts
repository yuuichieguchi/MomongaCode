import { DEFAULT_MAX_MESSAGE_BYTES, MessageTooLargeError, RequestError } from '@agentclientprotocol/sdk';
import type { AnyMessage } from '@agentclientprotocol/sdk';
import { JsonDepthError, isRecord, parseOutsideJson } from '@momonga/foundation';
import type { AcpStdio } from '../ports.ts';
import type { MessageStream } from './handover.ts';

export type HoldReason = 'adoption' | 'handover';

export type CarriedStream = {
  stream: MessageStream;
  pending(): Uint8Array;
  idle(): boolean;
  onIdle(listener: () => void): void;
  hold(reason: HoldReason): void;
  release(reason: HoldReason): void;
};

const LINE_END = 0x0a;

const joined = (first: Uint8Array, second: Uint8Array): Uint8Array => {
  const whole = new Uint8Array(first.byteLength + second.byteLength);
  whole.set(first, 0);
  whole.set(second, first.byteLength);
  return whole;
};

type RequestId = string | number;

const requestIdOf = (message: AnyMessage): RequestId | undefined => ('method' in message && 'id' in message && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : undefined);

const answeredIdOf = (message: AnyMessage): RequestId | undefined => (!('method' in message) && 'id' in message && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : undefined);

const refusalOf = (error: RequestError): AnyMessage => ({ jsonrpc: '2.0', id: null, error: error.toErrorResponse() });

export const carriedStream = (stdio: AcpStdio, carried: Uint8Array): CarriedStream => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const writer = stdio.output.getWriter();
  const holds = new Set<HoldReason>();
  const unanswered = new Set<RequestId>();
  const idleListeners = new Set<() => void>();
  let buffered = carried;
  let ended = false;
  let failure: { error: unknown } | undefined;
  let arriving = false;
  let changes: Array<() => void> = [];
  let written: Promise<void> = Promise.resolve();

  const changed = (): void => {
    const waiting = changes;
    changes = [];
    for (const wake of waiting) wake();
  };

  const nextChange = (): Promise<void> => new Promise((resolve) => void changes.push(resolve));

  const absorb = (): void => {
    for (let chunk = stdio.input.take(); chunk !== undefined; chunk = stdio.input.take()) buffered = joined(buffered, chunk);
  };

  const awaitArrival = (): void => {
    if (arriving) return;
    arriving = true;
    stdio.input.arrival().then(
      (kind) => {
        arriving = false;
        if (kind === 'end') ended = true;
        changed();
      },
      (error: unknown) => {
        arriving = false;
        failure = { error };
        changed();
      },
    );
  };

  const takeLine = (): Uint8Array | undefined => {
    const end = buffered.indexOf(LINE_END);
    if (end === -1) {
      if (buffered.byteLength > DEFAULT_MAX_MESSAGE_BYTES) throw new MessageTooLargeError(DEFAULT_MAX_MESSAGE_BYTES);
      if (!ended || buffered.byteLength === 0) return undefined;
      const last = buffered;
      buffered = new Uint8Array();
      return last;
    }
    if (end > DEFAULT_MAX_MESSAGE_BYTES) throw new MessageTooLargeError(DEFAULT_MAX_MESSAGE_BYTES);
    const line = buffered.subarray(0, end);
    buffered = buffered.slice(end + 1);
    return line;
  };

  const write = (message: AnyMessage): Promise<void> => {
    const sent = written.then(() => writer.write(encoder.encode(`${JSON.stringify(message)}\n`)));
    written = sent.catch(() => undefined);
    return sent;
  };

  const messageOf = async (line: Uint8Array): Promise<AnyMessage | undefined> => {
    const text = decoder.decode(line).trim();
    if (text === '') return undefined;
    let parsed: unknown;
    try {
      parsed = parseOutsideJson(text);
    } catch (error) {
      await write(refusalOf(error instanceof JsonDepthError ? RequestError.parseError(undefined, error.message) : RequestError.parseError()));
      return undefined;
    }
    if (Array.isArray(parsed)) {
      await write(refusalOf(RequestError.invalidRequest(undefined, 'JSON-RPC batches are not supported')));
      return undefined;
    }
    if (!isRecord(parsed)) {
      await write(refusalOf(RequestError.invalidRequest(parsed)));
      return undefined;
    }
    return parsed as AnyMessage;
  };

  const taken = (message: AnyMessage): void => {
    const id = requestIdOf(message);
    if (id !== undefined) unanswered.add(id);
  };

  const answered = (message: AnyMessage): void => {
    const id = answeredIdOf(message);
    if (id === undefined || !unanswered.delete(id) || unanswered.size > 0) return;
    for (const listener of [...idleListeners]) listener();
  };

  const readable = new ReadableStream<AnyMessage>(
    {
      pull: async (controller) => {
        for (;;) {
          if (failure !== undefined) throw failure.error;
          if (holds.size === 0) {
            absorb();
            const line = takeLine();
            if (line !== undefined) {
              const message = await messageOf(line);
              if (message === undefined) continue;
              taken(message);
              controller.enqueue(message);
              return;
            }
            if (ended) {
              controller.close();
              return;
            }
            awaitArrival();
          }
          await nextChange();
        }
      },
    },
    { highWaterMark: 0 },
  );

  const writable = new WritableStream<AnyMessage>({
    write: async (message) => {
      await write(message);
      answered(message);
    },
    close: async () => {
      await written;
      await writer.close();
    },
    abort: (reason) => writer.abort(reason),
  });

  return {
    stream: { readable, writable },
    pending: () => {
      absorb();
      return buffered.slice();
    },
    idle: () => unanswered.size === 0,
    onIdle: (listener) => void idleListeners.add(listener),
    hold: (reason) => void holds.add(reason),
    release: (reason) => {
      holds.delete(reason);
      changed();
    },
  };
};
