import { isFatalStoreError } from '@momonga/store';
import type { NewBilledDetail, CallTiming, CreateResponseBody, ModelCost, PlanAccountRef, ResponseResource, StreamEvent, UnpricedOutcome, Usage } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import { MODEL_COST_SCHEMA, carriesOutput, planAccountRefOf, reportedCachedTokensOf } from '@momonga/protocol';
import { defineProductSchema, productErrorsText } from '@momonga/foundation';
import type { ClaimContext } from './claim-context.ts';
import { streamAdmitted } from './admitted-request.ts';
import type { AdmissionProof } from './admitted-request.ts';
import { GatewayRequestError } from '../gateway-client.ts';

export { carriesOutput };

const FLUSH_INTERVAL_MS = 50;
const FLUSH_BYTES = 1024;

export type ModelResult =
  | { kind: 'response'; response: ResponseResource; incomplete: boolean }
  | { kind: 'failed'; code: string; message: string; retryable: boolean; plan?: PlanAccountRef };

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
    case 'response.failed': {
      const plan = planAccountRefOf(event.response.error.plan);
      return {
        kind: 'failed',
        code: event.response.error.code,
        message: event.response.error.message,
        retryable: event.response.momonga?.retryable === true,
        ...(plan === undefined ? {} : { plan }),
      };
    }
    default:
      return undefined;
  }
};

export const cachedInputOf = (usage: Usage, extension: { cacheReadNotReported?: true } | undefined): { cachedInputTokens?: number } => {
  const cachedInputTokens = reportedCachedTokensOf(usage, extension);
  return cachedInputTokens === undefined ? {} : { cachedInputTokens };
};

export type BilledExtension = { cacheReadNotReported?: true; cacheWriteInputTokens?: number; cost?: ModelCost; unpriced?: UnpricedOutcome };

const checkModelCost = defineProductSchema<ModelCost>('run-api/ModelCost', MODEL_COST_SCHEMA);

export const priceOutcomeOf = (extension: BilledExtension | undefined): { cost: ModelCost } | { unpriced: UnpricedOutcome } | Record<string, never> => {
  if (extension?.cost !== undefined) {
    const verdict = checkModelCost(extension.cost);
    return verdict.valid
      ? { cost: verdict.value }
      : { unpriced: { code: 'unpriceable_usage', reason: `the server replied with a cost that is not a valid price: ${productErrorsText(verdict.errors, 'cost')}` } };
  }
  if (extension?.unpriced !== undefined) return { unpriced: extension.unpriced };
  return {};
};

export const billedDetailOf = (usage: Usage | null, extension: BilledExtension | undefined, timing: CallTiming, responseId: string): NewBilledDetail => ({
  responseId,
  ...(usage === null ? {} : cachedInputOf(usage, extension)),
  ...(extension?.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: extension.cacheWriteInputTokens }),
  ...priceOutcomeOf(extension),
  timing,
});

export type StreamedModel = { result: ModelResult; timing: CallTiming };

export const streamModel = async (
  ctx: ClaimContext,
  body: CreateResponseBody,
  idempotencyKey: string,
  position: { step: number; attempt: number },
  proof: AdmissionProof,
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
        const events = streamAdmitted(ctx.options.gateway, proof, body, {
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
  if (terminal === undefined) throw new GatewayRequestError({ status: 0, type: 'transport', code: 'stream_interrupted', message: 'the gateway stream ended without a terminal event' });
  buffer.flush();
  return { result: terminal, timing: { ...(firstEventMs === undefined ? {} : { firstEventMs }), durationMs: clock.now() - startedAt } };
};
