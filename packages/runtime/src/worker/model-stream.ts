import type { CreateResponseBody, ResponseResource } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import type { ClaimContext } from './claim-context.ts';
import { GatewayFailureError } from './errors.ts';

const FLUSH_INTERVAL_MS = 50;
const FLUSH_BYTES = 1024;

export type ModelResult =
  | { kind: 'response'; response: ResponseResource; incomplete: boolean }
  | { kind: 'failed'; code: string | null; message: string };

type DeltaType = 'agent.message.delta' | 'agent.thought.delta';

type Pending = { type: DeltaType; itemId: string; text: string };

type DeltaBuffer = {
  add(type: DeltaType, itemId: string, text: string): void;
  flush(): void;
  dispose(): void;
};

const createDeltaBuffer = (
  append: (payloads: readonly RunEventPayload[]) => void,
  position: { step: number; attempt: number },
  onFailure: (error: unknown) => void,
): DeltaBuffer => {
  const pending = new Map<string, Pending>();
  let timer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    clearTimeout(timer);
    timer = undefined;
    if (pending.size === 0) return;
    const payloads = [...pending.values()].map(
      (entry): RunEventPayload => ({ type: entry.type, step: position.step, attempt: position.attempt, itemId: entry.itemId, text: entry.text }),
    );
    pending.clear();
    append(payloads);
  };

  return {
    add: (type, itemId, text) => {
      const key = `${type}:${itemId}`;
      const entry = pending.get(key) ?? { type, itemId, text: '' };
      entry.text += text;
      pending.set(key, entry);
      if (Buffer.byteLength(entry.text) >= FLUSH_BYTES) {
        flush();
      } else if (timer === undefined) {
        timer = setTimeout(() => {
          try {
            flush();
          } catch (error) {
            onFailure(error);
          }
        }, FLUSH_INTERVAL_MS);
      }
    },
    flush,
    dispose: () => {
      clearTimeout(timer);
      timer = undefined;
    },
  };
};

export const streamModel = async (
  ctx: ClaimContext,
  body: CreateResponseBody,
  idempotencyKey: string,
  position: { step: number; attempt: number },
): Promise<ModelResult> => {
  const buffer = createDeltaBuffer((payloads) => ctx.journal.append(payloads), position, (error) => ctx.control.fail(error));
  let terminal: ModelResult | undefined;
  try {
    await ctx.control.recordingRaised(
      (async (): Promise<void> => {
        const events = ctx.options.gateway.stream(body, {
          idempotencyKey,
          deadlineAt: ctx.run.deadlineAt,
          signal: ctx.control.signal,
          traceparent: ctx.agentSpan.traceparent,
        });
        for await (const event of events) {
          switch (event.type) {
            case 'response.output_text.delta':
              buffer.add('agent.message.delta', event.item_id, event.delta);
              break;
            case 'response.reasoning.delta':
            case 'response.reasoning_summary_text.delta':
              buffer.add('agent.thought.delta', event.item_id, event.delta);
              break;
            case 'response.completed':
              terminal = { kind: 'response', response: event.response, incomplete: false };
              break;
            case 'response.incomplete':
              terminal = { kind: 'response', response: event.response, incomplete: true };
              break;
            case 'response.failed':
              terminal = { kind: 'failed', code: event.response.error.code, message: event.response.error.message };
              break;
            case 'error':
              terminal = { kind: 'failed', code: event.error.code, message: event.error.message };
              break;
            default:
              break;
          }
        }
      })(),
    );
  } catch (error) {
    throw ctx.control.failure() ?? error;
  } finally {
    buffer.dispose();
  }
  const failure = ctx.control.failure();
  if (failure !== undefined) throw failure;
  if (terminal === undefined) throw new GatewayFailureError('the model stream ended without a terminal event');
  buffer.flush();
  return terminal;
};
