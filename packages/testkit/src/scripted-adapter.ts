import { SAMPLING_FIELDS, applyCapabilityOverride } from '@momonga/protocol';
import type {
  AdapterCompactRequest,
  AdapterCompactResult,
  AdapterContext,
  AdapterCountTokensResult,
  AdapterRequest,
  AdapterTarget,
  ClassifiedError,
  Capabilities,
  CapabilityOverride,
  CountTokensRequest,
  ProviderAdapter,
  StreamEvent,
} from '@momonga/protocol';
import type { FakeTimers } from './fake-timers.ts';

export type ScriptedFailure = { status: number; message: string; retryAfterMs?: number };

export type ScriptedCallPlan = {
  events?: readonly StreamEvent[];
  failure?: ScriptedFailure;
  delayMs?: number;
  gate?: { name: string; afterEvents: number };
};

export type ScriptedAdapterOptions = {
  kind?: string;
  calls: readonly ScriptedCallPlan[];
  capabilities?: CapabilityOverride;
  countTokens?: AdapterCountTokensResult;
  compactSummary?: string;
  compactGate?: string;
  timers?: Pick<FakeTimers, 'setTimeout' | 'clearTimeout'>;
};

export type RecordedAdapterCall = {
  request: AdapterRequest;
  target: AdapterTarget;
  attempt: number;
  signal: AbortSignal;
  emitted: number;
  outcome: 'pending' | 'completed' | 'failed' | 'aborted';
};

export type RecordedCompactCall = { request: AdapterCompactRequest; target: AdapterTarget };
export type RecordedCountCall = { request: CountTokensRequest; target: AdapterTarget };

export type ScriptedAdapter = ProviderAdapter & {
  readonly calls: RecordedAdapterCall[];
  readonly compactCalls: RecordedCompactCall[];
  readonly countCalls: RecordedCountCall[];
  release(gateName: string): void;
};

export class ScriptedUpstreamError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(failure: ScriptedFailure) {
    super(failure.message);
    this.name = 'ScriptedUpstreamError';
    this.status = failure.status;
    this.retryAfterMs = failure.retryAfterMs;
  }
}

export const DEFAULT_SCRIPTED_CAPABILITIES: Capabilities = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 4,
  source: 'declared',
};

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('scripted adapter call aborted');

export const createScriptedAdapter = (options: ScriptedAdapterOptions): ScriptedAdapter => {
  const calls: RecordedAdapterCall[] = [];
  const compactCalls: RecordedCompactCall[] = [];
  const countCalls: RecordedCountCall[] = [];
  const released = new Set<string>();
  const gateWaiters = new Map<string, Array<() => void>>();

  const waitForGate = (name: string, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (released.has(name)) {
        resolve();
        return;
      }
      if (signal.aborted) {
        reject(abortError(signal));
        return;
      }
      const onAbort = (): void => reject(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      const waiters = gateWaiters.get(name) ?? [];
      waiters.push(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
      gateWaiters.set(name, waiters);
    });

  const delay = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const timers = options.timers;
      if (timers === undefined) {
        reject(new Error('scripted adapter: delayMs requires injected timers'));
        return;
      }
      const onAbort = (): void => {
        timers.clearTimeout(handle);
        reject(abortError(signal));
      };
      const handle = timers.setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });

  async function* run(plan: ScriptedCallPlan, record: RecordedAdapterCall, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    try {
      if (plan.delayMs !== undefined) await delay(plan.delayMs, signal);
      const events = plan.events ?? [];
      for (let index = 0; index < events.length; index += 1) {
        if (plan.gate !== undefined && plan.gate.afterEvents === index) await waitForGate(plan.gate.name, signal);
        if (signal.aborted) throw abortError(signal);
        record.emitted += 1;
        yield events[index] as StreamEvent;
      }
      if (plan.gate !== undefined && plan.gate.afterEvents >= events.length) await waitForGate(plan.gate.name, signal);
      if (plan.failure !== undefined) throw new ScriptedUpstreamError(plan.failure);
      record.outcome = 'completed';
    } catch (error) {
      record.outcome = signal.aborted ? 'aborted' : 'failed';
      throw error;
    } finally {
      if (record.outcome === 'pending') record.outcome = signal.aborted ? 'aborted' : 'failed';
    }
  }

  const adapter: ScriptedAdapter = {
    kind: options.kind ?? 'scripted',
    sampling: { renders: SAMPLING_FIELDS },
    unknownFields: 'refuse',
    calls,
    compactCalls,
    countCalls,
    release: (gateName: string) => {
      released.add(gateName);
      for (const wake of gateWaiters.get(gateName)?.splice(0) ?? []) wake();
    },
    capabilities: async () => applyCapabilityOverride(DEFAULT_SCRIPTED_CAPABILITIES, options.capabilities ?? {}),
    toolChoiceWire: () => ({ forms: [], expressesRequired: true }),
    create: (request: AdapterRequest, ctx: AdapterContext) => {
      const plan = options.calls[calls.length];
      const record: RecordedAdapterCall = {
        request,
        target: ctx.target,
        attempt: ctx.attempt,
        signal: ctx.signal,
        emitted: 0,
        outcome: 'pending',
      };
      calls.push(record);
      if (plan === undefined) {
        record.outcome = 'failed';
        const message = `scripted adapter ${options.kind ?? 'scripted'}: no plan for call #${calls.length}`;
        return (async function* missingPlan(): AsyncGenerator<StreamEvent> {
          throw new Error(message);
        })();
      }
      return run(plan, record, ctx.signal);
    },
    classify: (error: unknown): ClassifiedError => {
      if (error instanceof ScriptedUpstreamError) {
        if (error.status === 429) {
          return {
            retryable: true,
            ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
            error: { type: 'too_many_requests', code: 'rate_limited', message: error.message, param: null },
          };
        }
        if (error.status >= 500) {
          return {
            retryable: true,
            ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
            error: { type: 'server_error', code: 'upstream_error', message: error.message, param: null },
          };
        }
        return { retryable: false, error: { type: 'invalid_request', code: 'upstream_rejected', message: error.message, param: null } };
      }
      return {
        retryable: false,
        error: { type: 'model_error', code: 'adapter_error', message: error instanceof Error ? error.message : String(error), param: null },
      };
    },
  };
  if (options.countTokens !== undefined) {
    const result = options.countTokens;
    adapter.countTokens = async (request: CountTokensRequest, ctx: AdapterContext) => {
      countCalls.push({ request, target: ctx.target });
      return result;
    };
  }
  if (options.compactSummary !== undefined) {
    const summary = options.compactSummary;
    adapter.compact = async (request: AdapterCompactRequest, ctx: AdapterContext): Promise<AdapterCompactResult> => {
      compactCalls.push({ request, target: ctx.target });
      if (options.compactGate !== undefined) await waitForGate(options.compactGate, ctx.signal);
      return { summary, usage: { input_tokens: 40, output_tokens: 8, total_tokens: 48, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    };
  }
  return adapter;
};
