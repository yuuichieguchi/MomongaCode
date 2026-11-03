import { isFatalStoreError } from '@momonga/store';
import type { BilledDetail, CallTiming, CreateResponseBody, MomongaResponseExtension, ResponseResource, StreamEvent, Usage } from '@momonga/protocol';
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

const flushRecordingFailure = (ctx: ClaimContext, buffer: DeltaBuffer): void => {
  try {
    buffer.flush();
  } catch (flushError) {
    if (isFatalStoreError(flushError)) throw flushError;
    if (!ctx.control.leaseLost()) ctx.control.fail(flushError);
  }
};

export const terminalResultOf = (event: StreamEvent): ModelResult | undefined => {
  switch (event.type) {
    case 'response.completed':
      return { kind: 'response', response: event.response, incomplete: false };
    case 'response.incomplete':
      return { kind: 'response', response: event.response, incomplete: true };
    case 'response.failed':
      return { kind: 'failed', code: event.response.error.code, message: event.response.error.message };
    case 'error':
      return { kind: 'failed', code: event.error.code, message: event.error.message };
    default:
      return undefined;
  }
};

export const billedDetailOf = (usage: Usage | null, extension: MomongaResponseExtension | undefined, timing: CallTiming, responseId: string): BilledDetail => ({
  responseId,
  ...(usage === null ? {} : { cachedInputTokens: usage.input_tokens_details.cached_tokens }),
  ...(extension?.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: extension.cacheWriteInputTokens }),
  ...(extension?.cost === undefined ? {} : { cost: extension.cost }),
  timing,
});

export const carriesOutput = (event: StreamEvent): boolean =>
  event.type === 'response.output_text.delta' ||
  event.type === 'response.reasoning.delta' ||
  event.type === 'response.reasoning_summary_text.delta' ||
  event.type === 'response.refusal.delta' ||
  event.type === 'response.function_call_arguments.delta' ||
  (event.type === 'response.output_item.added' && event.item.type === 'function_call');

export type StreamedModel = { result: ModelResult; timing: CallTiming };

export const streamModel = async (
  ctx: ClaimContext,
  body: CreateResponseBody,
  idempotencyKey: string,
  position: { step: number; attempt: number },
): Promise<StreamedModel> => {
  const buffer = createDeltaBuffer((payloads) => ctx.journal.append(payloads), position, (error) => ctx.control.fail(error));
  let terminal: ModelResult | undefined;
  let firstEventMs: number | undefined;
  const { clock } = ctx.options;
  ctx.journal.verifyLease();
  ctx.control.inFlight.modelKey = idempotencyKey;
  const startedAt = clock.now();
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
          if (firstEventMs === undefined && carriesOutput(event)) firstEventMs = clock.now() - startedAt;
          switch (event.type) {
            case 'response.output_text.delta':
              buffer.add('agent.message.delta', event.item_id, event.delta);
              break;
            case 'response.reasoning.delta':
            case 'response.reasoning_summary_text.delta':
              buffer.add('agent.thought.delta', event.item_id, event.delta);
              break;
            default: {
              const settled = terminalResultOf(event);
              if (settled !== undefined) terminal = settled;
              break;
            }
          }
        }
      })(),
    );
  } catch (error) {
    const original = ctx.control.failure() ?? error;
    if (!ctx.control.leaseLost()) flushRecordingFailure(ctx, buffer);
    throw original;
  } finally {
    buffer.dispose();
  }
  const failure = ctx.control.failure();
  if (failure !== undefined) throw failure;
  delete ctx.control.inFlight.modelKey;
  if (terminal === undefined) throw new GatewayFailureError('the model stream ended without a terminal event');
  buffer.flush();
  return { result: terminal, timing: { ...(firstEventMs === undefined ? {} : { firstEventMs }), durationMs: clock.now() - startedAt } };
};
