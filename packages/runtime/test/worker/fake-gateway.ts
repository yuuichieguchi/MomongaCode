import { createHash } from 'node:crypto';
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
  ModelView,
  MomongaModelRoles,
  ReasoningEffort,
  StreamEvent,
} from '@momonga/protocol';
import { quoteChain } from '@momonga/observability';
import type { PriceTable } from '@momonga/observability';
import { gatewayModelIn } from '@momonga/runtime';
import type { GatewayCallOptions, GatewayListing, GatewayModel, GatewayPort, ListedGatewayModel } from '@momonga/runtime';
import { fixtureCompactionContent, usageOf } from '@momonga/testkit';
import { createRequestValidator } from '../../../gateway/src/core/validation.ts';
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

export type RecordedCapabilities = { model: string; signal: AbortSignal | undefined };

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

export const FAKE_PROVIDER = 'fake';

export const FAKE_ADAPTER = 'chat-completions';

export const fakeViewsOf = (models: readonly string[]): ModelView[] => models.map((model) => ({ canon: model, provider: FAKE_PROVIDER, ownName: model }));

export const FALLBACK_TARGETS: readonly string[] = ['secondary'];

export const fakeCounterOf = (target: string): string => createHash('sha256').update(`fake counter of ${target}`).digest('hex');

const issueCallId = (): string => `call_${uuidv7().replaceAll('-', '')}`;

const validator = createRequestValidator();

type Refusal = { error: unknown };

const refusalOf = (parse: () => unknown): Refusal | undefined => {
  try {
    parse();
    return undefined;
  } catch (error) {
    return { error };
  }
};

async function* failing(error: unknown): AsyncGenerator<StreamEvent> {
  throw error;
}

const abortedPromise = (signal: AbortSignal): Promise<never> =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
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
  capabilitiesByModel: Record<string, Capabilities>;
  chainsByModel: Record<string, string[]>;
  countersByTarget: Map<string, string>;
  modelCalls: RecordedCapabilities[];
  listingCalls: number;
  listed: string[];
  alsoListed: () => readonly string[];
  memberFacts: Record<string, { adapter: string; upstream: string; answers: 'model' | 'script'; billing?: string; provider?: string }>;
  billed: { inputPerMTok: number; outputPerMTok: number } | 'unpriced' | undefined;
  prices: PriceTable;
  quotes: string[];
  quoteAt: number;
  unlisted: Set<string>;
  start: string | null;
  roles: MomongaModelRoles;
  effortsByModel: Record<string, ReasoningEffort>;
  counterOf(target: string): string;
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

  const withRoute = (event: StreamEvent, body: CreateResponseBody): StreamEvent => {
    if (event.type !== 'response.completed' && event.type !== 'response.incomplete') return event;
    const routed = event.response.momonga ?? { model: body.model, target: targetsOf(body.model)[0] ?? PRIMARY_TARGET, attempts: 1, usageSource: 'reported' as const };
    const counted = 'counter' in routed ? routed : { ...routed, counter: gateway.counterOf(routed.target) };
    return { ...event, response: { ...event.response, momonga: { ...counted, ...billedFieldsOf(event.response.usage) } } };
  };

  const billedFieldsOf = (usage: { input_tokens: number; output_tokens: number } | null): Record<string, unknown> => {
    if (gateway.billed === undefined || usage === null) return {};
    if (gateway.billed === 'unpriced') return { unpriced: { code: 'no_price_entry', reason: 'no price entry' } };
    const micro = usage.input_tokens * gateway.billed.inputPerMTok + usage.output_tokens * gateway.billed.outputPerMTok;
    return { cost: { amount: micro / 1_000_000, units: String(Math.round(micro * 1_000_000_000)), currency: 'USD', priceVersion: '2026-01-01' } };
  };

  const targetsOf = (model: string): string[] => {
    const named = gateway.chainsByModel[model];
    if (named !== undefined) return [...named];
    const known = [PRIMARY_TARGET, ...FALLBACK_TARGETS, ...gateway.capabilitiesByTarget.keys()];
    return known.filter((target, index) => known.indexOf(target) === index);
  };

  const listedModelOf = (model: string): ListedGatewayModel => {
    const capabilitiesOfModel = gateway.capabilitiesByModel[model] ?? gateway.capabilitiesValue;
    return {
      id: model,
      canon: model,
      provider: FAKE_PROVIDER,
      ownName: model,
      capabilities: { ...capabilitiesOfModel },
      chain: targetsOf(model).map((target) => ({
        model: target,
        counter: gateway.counterOf(target),
        ...(gateway.memberFacts[target] ?? { adapter: FAKE_ADAPTER, upstream: target, answers: 'model' as const }),
        capabilities: { ...(gateway.capabilitiesByTarget.get(target) ?? capabilitiesOfModel) },
      })),
      ...(gateway.effortsByModel[model] === undefined ? {} : { effort: gateway.effortsByModel[model] }),
    };
  };

  const listingWith = (asked?: string): GatewayListing => {
    const named = [
      ...(asked === undefined ? [] : [asked]),
      ...gateway.listed,
      ...gateway.alsoListed(),
      ...Object.keys(gateway.capabilitiesByModel),
      ...Object.keys(gateway.chainsByModel),
      ...Object.values(gateway.roles),
    ];
    const ids = named.filter((model, index) => named.indexOf(model) === index && !gateway.unlisted.has(model));
    const models = ids.map(listedModelOf);
    return {
      models,
      views: fakeViewsOf(ids),
      start: gateway.start ?? ids[0] ?? null,
      roles: { ...gateway.roles },
    };
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
      if (signal.aborted) throw signal.reason;
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
      if (signal.aborted) throw signal.reason;
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
    capabilitiesByModel: {},
    chainsByModel: {},
    countersByTarget: new Map(),
    modelCalls: [],
    listingCalls: 0,
    listed: [],
    alsoListed: () => [],
    memberFacts: {},
    billed: undefined,
    prices: [],
    quotes: [],
    quoteAt: Date.parse('2026-06-01T00:00:00Z'),
    unlisted: new Set(),
    start: null,
    roles: {},
    effortsByModel: {},
    counterOf: (target) => gateway.countersByTarget.get(target) ?? fakeCounterOf(target),
    rewriteCallIds: true,

    issuedCallIds: (scriptId) => [...(issued.get(scriptId) ?? [])],

    callId: (scriptId, occurrence = 0) => {
      const callId = issued.get(scriptId)?.[occurrence];
      if (callId === undefined) throw new Error(`fake gateway: no call id issued for ${scriptId} (occurrence ${occurrence})`);
      return callId;
    },

    stream: (body, options) => {
      if (options.signal.aborted) return failing(options.signal.reason);
      const refusal = refusalOf(() => validator.parseCreate(body));
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
      if (refusal !== undefined) return failing(refusal.error);
      if (cached !== undefined) return replay(cached, options.signal);
      if (running !== undefined) return attach(running, options.signal);
      return lead(startGeneration(key, body), options.signal);
    },

    compact: async (request, options) => {
      options.signal.throwIfAborted();
      gateway.compacts.push({
        request: structuredClone(request),
        idempotencyKey: options.idempotencyKey,
        deadlineAt: options.deadlineAt,
        traceparent: options.traceparent,
        signal: options.signal,
        runId: options.runId,
      });
      validator.parseCompact(request);
      await gateway.compactHook?.(request, options.signal);
      const summary = gateway.compactSummaries.shift() ?? `summary ${gateway.compacts.length}`;
      const item: ItemField = { type: 'compaction', id: `cmp_${gateway.compacts.length}`, encrypted_content: fixtureCompactionContent(summary) };
      const resource: CompactResource = {
        id: `compaction_${gateway.compacts.length}`,
        object: 'response.compaction',
        output: [item],
        created_at: 1_800_000_000,
        usage: usageOf(10, 5),
        momonga: { target: targetsOf(request.model)[0] ?? PRIMARY_TARGET },
      };
      return resource;
    },

    countTokens: async (request: CountTokensRequest, options?: { signal?: AbortSignal }): Promise<CountTokensResult> => {
      gateway.counts.push(request);
      gateway.countCalls.push({ request, signal: options?.signal });
      validator.parseCountTokens(request);
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

    capabilities: async (model, options) => {
      gateway.capabilityRequests.push(model);
      gateway.capabilitiesCalls.push({ model, signal: options?.signal });
      await gateway.capabilitiesHook?.(model, options?.signal);
      const target = options?.target;
      const listed = gatewayModelIn(listingWith(model), model);
      return (target === undefined ? undefined : gateway.capabilitiesByTarget.get(target)) ?? listed.capabilities;
    },

    model: async (model, options): Promise<GatewayModel> => {
      gateway.modelCalls.push({ model, signal: options.signal });
      return gatewayModelIn(listingWith(model), model);
    },

    listing: async (): Promise<GatewayListing> => {
      gateway.listingCalls += 1;
      return listingWith();
    },

    cancel: async (idempotencyKey, options) => {
      gateway.cancels.push({ idempotencyKey, signal: options?.signal });
      await gateway.cancelHook?.(idempotencyKey, options?.signal);
      return gateway.cancelResult;
    },

    quote: async (model) => {
      gateway.quotes.push(model);
      const members = targetsOf(model).map((target) => {
        const facts = gateway.memberFacts[target];
        return { billing: facts?.billing, provider: facts?.provider, model: facts?.upstream ?? target };
      });
      return quoteChain(model, members, gateway.prices, gateway.quoteAt);
    },

    releaseAll: () => {
      for (const gate of gates) gate.resolve();
    },

    nthStream: (index) => waiterFor(index).promise,
  };
  return gateway;
};
