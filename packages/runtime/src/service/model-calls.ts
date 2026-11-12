import { MAX_BILLED_CALLS_PAGE, RUNLESS, buildCostBreakdown, buildCostReport, callPriceOf, formatCostBreakdown, formatCostReport, runCostsOf } from '@momonga/observability';
import type { BreakdownCall, BreakdownPrefix, CallPrice, CostBreakdown, CostReport, CostedRun, RunCostCall, UnjoinedRecord } from '@momonga/observability';
import { RUN_ROLE, isLegacyPrecisionCost, unitsOfCost } from '@momonga/protocol';
import type {
  BilledCallsCursorView,
  BilledCallsPageView,
  BilledCallView,
  CallTiming,
  RecordedModelCost,
  RecordedCost,
  RecordedPrice,
  RunCostView,
  RunEvent,
  RunEventPayload,
  RunTraceCall,
  RunTraceEvent,
  RunTracePrefix,
  UnpricedOutcome,
} from '@momonga/protocol';
import type { ModelCallRecord, RuntimeStore } from '@momonga/store';
import { gatewayProtocolError } from '../gateway-client.ts';

export const traceCallsOf = (records: readonly ModelCallRecord[]): RunTraceCall[] =>
  records.flatMap((record) =>
    record.kind === 'requested'
      ? [
          {
            step: record.step,
            attempt: record.attempt,
            ...(record.anatomy === undefined ? {} : { anatomy: record.anatomy }),
            ...(record.prefix === undefined ? {} : { prefix: record.prefix }),
          },
        ]
      : [],
  );

export const TRACE_EVENT_TYPES = ['tool.loaded', 'loop.warned'] as const satisfies readonly RunEventPayload['type'][];

export const traceEventsOf = (events: readonly RunEvent[]): RunTraceEvent[] =>
  events.flatMap((event): RunTraceEvent[] => {
    if (event.type === 'tool.loaded') return [{ step: event.step, type: 'tool.loaded', names: event.names }];
    if (event.type === 'loop.warned') return [{ step: event.step, type: 'loop.warned', signature: event.signature }];
    return [];
  });

type Response = Pick<BreakdownCall, 'anatomy' | 'prefix' | 'timing'> & { step: number; id?: string };

const prefixOf = (prefix: RunTracePrefix | undefined): BreakdownPrefix | undefined => {
  if (prefix === undefined) return undefined;
  return prefix.toolsChanged || prefix.causes.length > 0 ? { broken: true, causes: prefix.causes } : { broken: false };
};

const responsesOf = (records: readonly ModelCallRecord[]): Response[] => {
  const requests = new Map<string, ModelCallRecord>();
  const responses: Response[] = [];
  for (const record of records) {
    if (record.kind === 'requested') {
      requests.set(`${record.step}:${record.attempt}`, record);
      continue;
    }
    const request = requests.get(`${record.step}:${record.attempt}`);
    const anatomy = request?.kind === 'requested' ? request.anatomy : undefined;
    const prefix = request?.kind === 'requested' ? prefixOf(request.prefix) : undefined;
    responses.push({
      step: record.step,
      ...(record.responseId === undefined ? {} : { id: record.responseId }),
      ...(anatomy === undefined ? {} : { anatomy }),
      ...(prefix === undefined ? {} : { prefix }),
      ...(record.timing === undefined ? {} : { timing: record.timing }),
    });
  }
  return responses;
};

const recordedPriceOf = (billed: { cost?: RecordedModelCost; unpriced?: UnpricedOutcome } | undefined): RecordedPrice => {
  if (billed?.cost !== undefined) return { kind: 'priced', cost: billed.cost };
  if (billed?.unpriced !== undefined) return { kind: 'unpriced', ...billed.unpriced };
  return { kind: 'not_recorded' };
};

const COST_RECORD_EVENT_TYPES = ['model.responded', 'usage.charged'] as const satisfies readonly RunEventPayload['type'][];

export type CostRecordStore = Pick<RuntimeStore, 'readRunEventsOfTypes' | 'contextCharges'>;

const idField = (responseId: string | undefined): { responseId?: string } => (responseId === undefined ? {} : { responseId });

const journalCostsOf = (store: CostRecordStore, runId: string): RecordedCost[] =>
  store.readRunEventsOfTypes(runId, COST_RECORD_EVENT_TYPES).flatMap((event): RecordedCost[] => {
    if (event.type === 'model.responded') {
      const retryOf = event.response.momonga?.retryOf;
      return [{ runId, ...idField(event.response.id), step: event.step, price: recordedPriceOf(event.response.momonga), ...(retryOf === undefined ? {} : { retryOf }) }];
    }
    if (event.type === 'usage.charged') return [{ runId, ...idField(event.responseId), step: event.step, price: recordedPriceOf(event) }];
    return [];
  });

export const readRecordedCosts = (store: CostRecordStore, runIds: readonly string[], includeRunless: boolean): RecordedCost[] => {
  const ofJournals = runIds.flatMap((runId) => journalCostsOf(store, runId));
  const ofRunCharges = store.contextCharges.list({ runIds }).map((charge): RecordedCost => {
    if (charge.runId === null) throw new RangeError(`context charge ${charge.id} was listed for runs and belongs to none`);
    return { runId: charge.runId, ...idField(charge.detail?.responseId), price: recordedPriceOf(charge.detail) };
  });
  const ofNoRun = includeRunless
    ? store.contextCharges.list({}).flatMap((charge): RecordedCost[] => (charge.runId === null ? [{ runId: RUNLESS, ...idField(charge.detail?.responseId), price: recordedPriceOf(charge.detail) }] : []))
    : [];
  return [...ofJournals, ...ofRunCharges, ...ofNoRun];
};

const runCostCallOf = (recorded: RecordedCost): RunCostCall => ({
  runId: recorded.runId,
  retried: recorded.retryOf !== undefined,
  price: recorded.price.kind === 'priced' ? { kind: 'priced', units: unitsOfCost(recorded.price.cost).toString(), priceVersion: recorded.price.cost.priceVersion, legacyPrecision: isLegacyPrecisionCost(recorded.price.cost) } : { kind: recorded.price.kind },
});

export const reportCostOf = (store: CostRecordStore, runIds: readonly string[]): RunCostView[] => runCostsOf(runIds, readRecordedCosts(store, runIds, false).map(runCostCallOf));

type RecordedPrices = ReadonlyMap<string, RecordedPrice>;

const NOT_RECORDED: RecordedPrice = { kind: 'not_recorded' };

const pricesByResponse = (recorded: readonly RecordedCost[]): RecordedPrices =>
  new Map(recorded.flatMap((entry): [string, RecordedPrice][] => (entry.responseId === undefined ? [] : [[entry.responseId, entry.price]])));

const retriedResponses = (recorded: readonly RecordedCost[]): ReadonlySet<string> =>
  new Set(recorded.flatMap((entry) => (entry.responseId === undefined || entry.retryOf === undefined ? [] : [entry.responseId])));

const retriedIn = (retried: ReadonlySet<string>, call: BilledCallView): boolean => call.responseId !== undefined && retried.has(call.responseId);

const callPriceIn = (prices: RecordedPrices, call: BilledCallView): CallPrice =>
  callPriceOf((call.responseId === undefined ? undefined : prices.get(call.responseId)) ?? NOT_RECORDED);

const breakdownCallOf = (call: BilledCallView, price: CallPrice, joined: Partial<Response>): BreakdownCall => ({
  runId: call.runId,
  ...(call.step === undefined ? {} : { step: call.step }),
  ...(call.role === undefined ? {} : { role: call.role }),
  provider: call.provider,
  model: call.model,
  ...(call.target === undefined ? {} : { target: call.target }),
  billing: call.billing,
  at: new Date(call.startMs),
  price,
  usage: call.usage,
  ...(joined.anatomy === undefined ? {} : { anatomy: joined.anatomy }),
  ...(joined.prefix === undefined ? {} : { prefix: joined.prefix }),
  ...(joined.timing === undefined ? {} : { timing: joined.timing }),
});

const isMain = (call: BilledCallView): boolean => (call.role ?? RUN_ROLE) === RUN_ROLE;

export type SideTiming = { responseId: string; timing: CallTiming };

export const runlessTimingsOf = (store: Pick<RuntimeStore, 'contextCharges'>): SideTiming[] =>
  store.contextCharges
    .list({})
    .flatMap((charge) => (charge.runId === null && charge.detail?.responseId !== undefined && charge.detail.timing !== undefined ? [{ responseId: charge.detail.responseId, timing: charge.detail.timing }] : []));

export const sideTimingsOfRun = (store: Pick<RuntimeStore, 'readRunEventsOfTypes' | 'contextCharges'>, runId: string): SideTiming[] => {
  const charged = store.readRunEventsOfTypes(runId, ['usage.charged']).flatMap((event) =>
    event.type === 'usage.charged' && event.responseId !== undefined && event.timing !== undefined ? [{ responseId: event.responseId, timing: event.timing }] : [],
  );
  const reflected = store.contextCharges
    .list({ runIds: [runId] })
    .flatMap((charge) => (charge.detail?.responseId !== undefined && charge.detail.timing !== undefined ? [{ responseId: charge.detail.responseId, timing: charge.detail.timing }] : []));
  return [...charged, ...reflected];
};

export const joinRunCalls = (
  runId: string,
  billed: readonly BilledCallView[],
  records: readonly ModelCallRecord[],
  sideTimingList: readonly SideTiming[],
  prices: RecordedPrices,
): { calls: BreakdownCall[]; unjoined: UnjoinedRecord[]; withoutResponseId: number } => {
  const responses = responsesOf(records);
  const sideTimings = new Map(sideTimingList.map((entry) => [entry.responseId, entry.timing]));
  let withoutResponseId = 0;
  const firstById = new Map<string, Response>();
  for (const response of responses) {
    if (response.id !== undefined && !firstById.has(response.id)) firstById.set(response.id, response);
  }
  const matched = new Set<string>();
  const calls: BreakdownCall[] = [];
  const unjoined: UnjoinedRecord[] = [];
  for (const call of billed) {
    const stepField = call.step === undefined ? {} : { step: call.step };
    if (!isMain(call)) {
      const timing = call.responseId === undefined ? undefined : sideTimings.get(call.responseId);
      calls.push(breakdownCallOf(call, callPriceIn(prices, call), timing === undefined ? {} : { timing }));
    } else if (call.responseId === undefined) {
      calls.push(breakdownCallOf(call, callPriceIn(prices, call), {}));
      withoutResponseId += 1;
    } else {
      const answer = firstById.get(call.responseId);
      calls.push(breakdownCallOf(call, callPriceIn(prices, call), answer ?? {}));
      if (answer === undefined) unjoined.push({ runId, ...stepField, reason: 'a billed model call has no recorded model response' });
      else matched.add(call.responseId);
    }
  }
  for (const response of responses) {
    if (response.id !== undefined && !matched.has(response.id) && firstById.get(response.id) === response) {
      unjoined.push({ runId, step: response.step, reason: 'a recorded model response has no billed model call' });
    }
  }
  return { calls, unjoined, withoutResponseId };
};

const isCursorNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const advances = (from: BilledCallsCursorView, to: BilledCallsCursorView): boolean => to.run > from.run || (to.run === from.run && to.after > from.after);

export type CostBreakdownSources = {
  runIds: readonly string[];
  recordsOf: (runId: string) => Promise<readonly ModelCallRecord[]>;
  fetchPage: (runIds: readonly string[], cursor: BilledCallsCursorView, limit: number) => Promise<BilledCallsPageView>;
  recordedCosts: () => readonly RecordedCost[];
  sideTimingsOf?: (runId: string) => readonly SideTiming[];
  runlessTimingsOf?: () => readonly SideTiming[];
  pageSize?: number;
};

export type BilledCallsSource = Pick<CostBreakdownSources, 'runIds' | 'fetchPage' | 'pageSize'>;

export const billedCallsOf = async (sources: BilledCallsSource): Promise<BilledCallView[]> => {
  const billed: BilledCallView[] = [];
  let cursor: BilledCallsCursorView | undefined = { run: 0, after: 0 };
  while (cursor !== undefined) {
    const page: BilledCallsPageView = await sources.fetchPage(sources.runIds, cursor, sources.pageSize ?? MAX_BILLED_CALLS_PAGE);
    billed.push(...page.calls);
    const { next } = page;
    if (next !== undefined) {
      if (!isCursorNumber(next.run) || !isCursorNumber(next.after)) {
        throw gatewayProtocolError('the billed calls page names a cursor that is not a pair of non-negative integers');
      }
      if (!advances(cursor, next)) {
        throw gatewayProtocolError(`the billed calls page names the cursor ${JSON.stringify(next)}, which does not advance past ${JSON.stringify(cursor)}`);
      }
      if (page.calls.length === 0) throw gatewayProtocolError('the billed calls page is an empty page that names a next cursor');
    }
    cursor = next;
  }
  return billed;
};

export type CostReportSources = Pick<CostBreakdownSources, 'fetchPage' | 'recordedCosts' | 'pageSize'> & { runs: readonly CostedRun[]; includeRunless: boolean };

export const costReportOf = async (sources: CostReportSources): Promise<{ report: CostReport; text: string }> => {
  const billed = await billedCallsOf({ runIds: sources.runs.map((run) => run.runId), fetchPage: sources.fetchPage, ...(sources.pageSize === undefined ? {} : { pageSize: sources.pageSize }) });
  const recorded = sources.recordedCosts();
  const prices = pricesByResponse(recorded);
  const retried = retriedResponses(recorded);
  const report = buildCostReport(billed.map((call) => ({ ...call, price: callPriceIn(prices, call), retried: retriedIn(retried, call) })), sources.runs, { includeRunless: sources.includeRunless });
  return { report, text: formatCostReport(report) };
};

export const costBreakdownOf = async (sources: CostBreakdownSources): Promise<{ breakdown: CostBreakdown; text: string }> => {
  const { runIds } = sources;
  const billed = await billedCallsOf(sources);
  const prices = pricesByResponse(sources.recordedCosts());
  const joined: ReturnType<typeof joinRunCalls>[] = [];
  for (const runId of runIds) {
    joined.push(joinRunCalls(runId, billed.filter((call) => call.runId === runId), await sources.recordsOf(runId), sources.sideTimingsOf === undefined ? [] : sources.sideTimingsOf(runId), prices));
  }
  const runlessTimings = new Map((sources.runlessTimingsOf === undefined ? [] : sources.runlessTimingsOf()).map((entry) => [entry.responseId, entry.timing]));
  const runless = billed
    .filter((call) => call.runId === RUNLESS)
    .map((call) => {
      const timing = call.responseId === undefined ? undefined : runlessTimings.get(call.responseId);
      return breakdownCallOf(call, callPriceIn(prices, call), timing === undefined ? {} : { timing });
    });
  const breakdown = buildCostBreakdown(
    [...joined.flatMap((entry) => entry.calls), ...runless],
    { unjoined: joined.flatMap((entry) => entry.unjoined), callsWithoutResponseId: joined.reduce((sum, entry) => sum + entry.withoutResponseId, 0) },
  );
  return { breakdown, text: formatCostBreakdown(breakdown) };
};
