import { canonicalJson, uuidv7 } from '@momonga/foundation';
import { ESTIMATED_ERROR_SHAPE, EXACT_ERROR_SHAPE, countReplyOf } from '@momonga/protocol';
import type {
  Capabilities,
  CompactRequest,
  CompactResource,
  CountTokensRequest,
  CountTokensResult,
  CreateResponseBody,
  ErrorShape,
  ItemField,
  StreamEvent,
} from '@momonga/protocol';
import type { GatewayCallOptions, GatewayPort } from '@momonga/runtime';
import { fixtureCompactionContent, usageOf } from '@momonga/testkit';
import { deferred } from './deferred.ts';
import type { Deferred } from './deferred.ts';

export type RecordedStream = {
  index: number;
  idempotencyKey: string;
  body: CreateResponseBody;
  traceparent: string | undefined;
  deadlineAt: number;
  signal: AbortSignal;
  deduplicated: boolean;
  role: GatewayCallOptions['role'];
};

export type RecordedCompact = {
  request: CompactRequest;
  idempotencyKey: string;
  deadlineAt: number;
  traceparent: string | undefined;
  signal: AbortSignal;
  runId: string | undefined;
};

export type RecordedCount = { request: CountTokensRequest; signal: AbortSignal | undefined };

export type RecordedCapabilities = { alias: string; signal: AbortSignal | undefined };

export type RecordedCancel = { idempotencyKey: string; signal: AbortSignal | undefined };

export type GatewayHook<R> = (request: R, signal: AbortSignal | undefined) => Promise<void>;

export const AUTO_OUTPUT_TOKENS = 10;

export type ScriptStep = {
  events: StreamEvent[];
  autoUsage?: true;
  error?: Error;
  gate?: { afterEvents: number; release: Deferred<void>; reached: Deferred<void> };
};

type Generation = {
  step: ScriptStep;
  outcome: Promise<{ kind: 'events'; events: StreamEvent[] } | { kind: 'error'; error: Error }>;
};

export class FakeAbortError extends Error {
  constructor() {
    super('The operation was aborted');
    this.name = 'AbortError';
  }
}

export const tokensOfText = (text: string): number => Math.ceil(text.length / 4);

const isStoredTerminal = (events: readonly StreamEvent[]): boolean => {
  const last = events.at(-1);
  return last !== undefined && (last.type === 'response.completed' || last.type === 'response.incomplete');
};

export const inputTokensOf = (body: CreateResponseBody): number => {
  const input = body.input;
  const inputTokens =
    input === undefined || input === null
      ? 0
      : typeof input === 'string'
        ? tokensOfText(input)
        : input.reduce((sum, item) => sum + tokensOfText(canonicalJson(item)), 0);
  const instructions = body.instructions === undefined || body.instructions === null ? 0 : tokensOfText(body.instructions);
  const tools = (body.tools ?? []).reduce((sum, tool) => sum + tokensOfText(canonicalJson(tool)), 0);
  return inputTokens + instructions + tools;
};

const withObservedUsage = (events: readonly StreamEvent[], body: CreateResponseBody): StreamEvent[] =>
  events.map((event) =>
    event.type === 'response.completed' || event.type === 'response.incomplete'
      ? { ...event, response: { ...event.response, usage: usageOf(inputTokensOf(body), AUTO_OUTPUT_TOKENS) } }
      : event,
  );

export const PRIMARY_TARGET = 'primary';

const withRoute = (event: StreamEvent, body: CreateResponseBody): StreamEvent =>
  (event.type === 'response.completed' || event.type === 'response.incomplete') && event.response.momonga === undefined
    ? { ...event, response: { ...event.response, momonga: { alias: body.model, target: PRIMARY_TARGET, attempts: 1, usageSource: 'reported' } } }
    : event;

const issueCallId = (): string => `call_${uuidv7().replaceAll('-', '')}`;

const abortedPromise = (signal: AbortSignal): Promise<never> =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new FakeAbortError());
    else signal.addEventListener('abort', () => reject(new FakeAbortError()), { once: true });
  });

export type FakeGateway = GatewayPort & {
  script: ScriptStep[];
  streams: RecordedStream[];
  compacts: RecordedCompact[];
  counts: CountTokensRequest[];
  countCalls: RecordedCount[];
  countResults: CountTokensResult[];
  countScaleByTarget: Map<string, number>;
  countMethod: CountTokensResult['method'];
  countMethodByTarget: Map<string, CountTokensResult['method']>;
  countShape: ErrorShape | undefined;
  capabilitiesByTarget: Map<string, Capabilities>;
  countHook: GatewayHook<CountTokensRequest> | undefined;
  compactHook: GatewayHook<CompactRequest> | undefined;
  capabilityRequests: string[];
  capabilitiesCalls: RecordedCapabilities[];
  capabilitiesHook: GatewayHook<string> | undefined;
  cancels: RecordedCancel[];
  cancelHook: GatewayHook<string> | undefined;
  cancelResult: boolean;
  generations: Map<string, number>;
  compactSummaries: string[];
  capabilitiesValue: Capabilities;
  capabilitiesByAlias: Record<string, Capabilities>;
  rewriteCallIds: boolean;
  issuedCallIds(scriptId: string): string[];
  callId(scriptId: string, occurrence?: number): string;
  releaseAll(): void;
  nthStream(index: number): Promise<RecordedStream>;
};

export const createFakeGateway = (capabilities: Capabilities): FakeGateway => {
  const completed = new Map<string, StreamEvent[]>();
  const inFlight = new Map<string, Generation>();
  const waiters = new Map<number, Deferred<RecordedStream>>();
  const gates: Deferred<void>[] = [];
  const issued = new Map<string, string[]>();

  const withIssuedCallIds = (events: readonly StreamEvent[]): StreamEvent[] => {
    const callIds = new Map<string, string>();
    const rewriteItem = (item: ItemField): ItemField => {
      if (item.type !== 'function_call') return item;
      let callId = callIds.get(item.call_id);
      if (callId === undefined) {
        callId = issueCallId();
        callIds.set(item.call_id, callId);
        issued.set(item.call_id, [...(issued.get(item.call_id) ?? []), callId]);
      }
      return { ...item, call_id: callId };
    };
    return events.map((event): StreamEvent => {
      if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') return { ...event, item: rewriteItem(event.item) };
      if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed')
        return { ...event, response: { ...event.response, output: event.response.output.map(rewriteItem) } } as StreamEvent;
      return event;
    });
  };

  const waiterFor = (index: number): Deferred<RecordedStream> => {
    const existing = waiters.get(index);
    if (existing !== undefined) return existing;
    const created = deferred<RecordedStream>();
    waiters.set(index, created);
    return created;
  };

  const settle = (key: string, generation: Generation): void => {
    void generation.outcome.then((outcome) => {
      if (inFlight.get(key) === generation) inFlight.delete(key);
      if (outcome.kind === 'events' && isStoredTerminal(outcome.events)) completed.set(key, outcome.events);
    });
  };

  let generationCount = 0;
  const startGeneration = (key: string, body: CreateResponseBody): Generation => {
    const scripted = gateway.script.shift();
    if (scripted === undefined) throw new Error(`fake gateway: no scripted step left for key ${key}`);
    const observed: ScriptStep = scripted.autoUsage === true ? { ...scripted, events: withObservedUsage(scripted.events, body) } : scripted;
    generationCount += 1;
    const issuedId = `resp_generation_${generationCount}`;
    const identified: ScriptStep = {
      ...observed,
      events: observed.events.map((event) => ('response' in event && typeof event.response === 'object' && event.response !== null ? ({ ...event, response: { ...event.response, id: issuedId } } as StreamEvent) : event)).map((event) => withRoute(event, body)),
    };
    const step: ScriptStep = gateway.rewriteCallIds ? { ...identified, events: withIssuedCallIds(identified.events) } : identified;
    gateway.generations.set(key, (gateway.generations.get(key) ?? 0) + 1);
    if (step.gate !== undefined) gates.push(step.gate.release);
    const outcome = (async () => {
      if (step.gate !== undefined) await step.gate.release.promise;
      if (step.error !== undefined) return { kind: 'error' as const, error: step.error };
      return { kind: 'events' as const, events: step.events };
    })();
    const generation = { step, outcome };
    inFlight.set(key, generation);
    settle(key, generation);
    return generation;
  };

  async function* replay(events: readonly StreamEvent[], signal: AbortSignal): AsyncGenerator<StreamEvent> {
    for (const event of events) {
      if (signal.aborted) throw new FakeAbortError();
      yield event;
    }
  }

  async function* attach(generation: Generation, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const outcome = await Promise.race([generation.outcome, abortedPromise(signal)]);
    if (outcome.kind === 'error') throw outcome.error;
    yield* replay(outcome.events, signal);
  }

  async function* lead(generation: Generation, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const { step } = generation;
    const prefixLength = step.gate === undefined ? 0 : Math.min(step.gate.afterEvents, step.events.length);
    for (const event of step.events.slice(0, prefixLength)) {
      if (signal.aborted) throw new FakeAbortError();
      yield event;
    }
    step.gate?.reached.resolve();
    const outcome = await Promise.race([generation.outcome, abortedPromise(signal)]);
    if (outcome.kind === 'error') throw outcome.error;
    yield* replay(outcome.events.slice(prefixLength), signal);
  }

  const gateway: FakeGateway = {
    script: [],
    streams: [],
    compacts: [],
    counts: [],
    countCalls: [],
    countResults: [],
    countScaleByTarget: new Map(),
    countMethod: 'exact',
    countMethodByTarget: new Map(),
    countShape: undefined,
    capabilitiesByTarget: new Map(),
    countHook: undefined,
    compactHook: undefined,
    capabilityRequests: [],
    capabilitiesCalls: [],
    capabilitiesHook: undefined,
    cancels: [],
    cancelHook: undefined,
    cancelResult: true,
    generations: new Map(),
    compactSummaries: [],
    capabilitiesValue: capabilities,
    capabilitiesByAlias: {},
    rewriteCallIds: true,

    issuedCallIds: (scriptId) => [...(issued.get(scriptId) ?? [])],

    callId: (scriptId, occurrence = 0) => {
      const callId = issued.get(scriptId)?.[occurrence];
      if (callId === undefined) throw new Error(`fake gateway: no call id issued for ${scriptId} (occurrence ${occurrence})`);
      return callId;
    },

    stream: (body, options) => {
      const key = options.idempotencyKey;
      const cached = completed.get(key);
      const running = inFlight.get(key);
      const record: RecordedStream = {
        index: gateway.streams.length,
        idempotencyKey: key,
        body: structuredClone(body),
        traceparent: options.traceparent,
        deadlineAt: options.deadlineAt,
        signal: options.signal,
        deduplicated: cached !== undefined || running !== undefined,
        role: options.role,
      };
      gateway.streams.push(record);
      waiterFor(record.index).resolve(record);
      if (cached !== undefined) return replay(cached, options.signal);
      if (running !== undefined) return attach(running, options.signal);
      return lead(startGeneration(key, body), options.signal);
    },

    compact: async (request, options) => {
      gateway.compacts.push({
        request: structuredClone(request),
        idempotencyKey: options.idempotencyKey,
        deadlineAt: options.deadlineAt,
        traceparent: options.traceparent,
        signal: options.signal,
        runId: options.runId,
      });
      await gateway.compactHook?.(request, options.signal);
      const summary = gateway.compactSummaries.shift() ?? `summary ${gateway.compacts.length}`;
      const item: ItemField = { type: 'compaction', id: `cmp_${gateway.compacts.length}`, encrypted_content: fixtureCompactionContent(summary) };
      const resource: CompactResource = {
        id: `compaction_${gateway.compacts.length}`,
        object: 'response.compaction',
        output: [item],
        created_at: 1_800_000_000,
        usage: usageOf(10, 5),
      };
      return resource;
    },

    countTokens: async (request: CountTokensRequest, options?: { signal?: AbortSignal }): Promise<CountTokensResult> => {
      gateway.counts.push(request);
      gateway.countCalls.push({ request, signal: options?.signal });
      await gateway.countHook?.(request, options?.signal);
      const instructions = request.instructions === undefined || request.instructions === null ? 0 : tokensOfText(request.instructions);
      const input =
        typeof request.input === 'string'
          ? tokensOfText(request.input)
          : request.input.reduce((sum, item) => sum + tokensOfText(canonicalJson(item)), 0);
      const tools = (request.tools ?? []).reduce((sum, tool) => sum + tokensOfText(canonicalJson(tool)), 0);
      const base = instructions + input + tools;
      const target = request.momonga?.target;
      const scale = target === undefined ? undefined : gateway.countScaleByTarget.get(target);
      const method = (target === undefined ? undefined : gateway.countMethodByTarget.get(target)) ?? gateway.countMethod;
      const result = countReplyOf(scale === undefined ? base : Math.ceil(base * scale), method, gateway.countShape ?? (method === 'estimated' ? ESTIMATED_ERROR_SHAPE : EXACT_ERROR_SHAPE));
      gateway.countResults.push(result);
      return result;
    },

    capabilities: async (alias, options) => {
      gateway.capabilityRequests.push(alias);
      gateway.capabilitiesCalls.push({ alias, signal: options?.signal });
      await gateway.capabilitiesHook?.(alias, options?.signal);
      const target = options?.target;
      return (target === undefined ? undefined : gateway.capabilitiesByTarget.get(target)) ?? gateway.capabilitiesByAlias[alias] ?? gateway.capabilitiesValue;
    },

    cancel: async (idempotencyKey, options) => {
      gateway.cancels.push({ idempotencyKey, signal: options?.signal });
      await gateway.cancelHook?.(idempotencyKey, options?.signal);
      return gateway.cancelResult;
    },

    releaseAll: () => {
      for (const gate of gates) gate.resolve();
    },

    nthStream: (index) => waiterFor(index).promise,
  };
  return gateway;
};
