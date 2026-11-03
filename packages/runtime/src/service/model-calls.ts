import { MAX_BILLED_CALLS_PAGE, RUNLESS, buildCostBreakdown, formatCostBreakdown } from '@momonga/observability';
import type { BreakdownCall, CostBreakdown, UnjoinedRecord } from '@momonga/observability';
import { RUN_ROLE } from '@momonga/protocol';
import type { BilledCallsCursorView, BilledCallsPageView, BilledCallView, CallTiming, RunTraceCall } from '@momonga/protocol';
import type { ModelCallRecord, RuntimeStore } from '@momonga/store';
import { gatewayProtocolError } from '../gateway-client.ts';

export const traceCallsOf = (records: readonly ModelCallRecord[]): RunTraceCall[] =>
  records.flatMap((record) =>
    record.kind === 'requested' ? [{ step: record.step, attempt: record.attempt, ...(record.anatomy === undefined ? {} : { anatomy: record.anatomy }) }] : [],
  );

type Response = Pick<BreakdownCall, 'anatomy' | 'timing'> & { step: number; id?: string };

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
    responses.push({
      step: record.step,
      ...(record.responseId === undefined ? {} : { id: record.responseId }),
      ...(anatomy === undefined ? {} : { anatomy }),
      ...(record.timing === undefined ? {} : { timing: record.timing }),
    });
  }
  return responses;
};

const breakdownCallOf = (call: BilledCallView, joined: Partial<Response>): BreakdownCall => ({
  runId: call.runId,
  ...(call.step === undefined ? {} : { step: call.step }),
  ...(call.role === undefined ? {} : { role: call.role }),
  provider: call.provider,
  model: call.model,
  billing: call.billing,
  at: new Date(call.startMs),
  price:
    call.price.kind === 'priced'
      ? { kind: 'priced', units: BigInt(call.price.units), currency: 'USD', priceVersion: call.price.priceVersion }
      : call.price,
  usage: call.usage,
  ...(joined.anatomy === undefined ? {} : { anatomy: joined.anatomy }),
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
      calls.push(breakdownCallOf(call, timing === undefined ? {} : { timing }));
    } else if (call.responseId === undefined) {
      calls.push(breakdownCallOf(call, {}));
      withoutResponseId += 1;
    } else {
      const answer = firstById.get(call.responseId);
      calls.push(breakdownCallOf(call, answer ?? {}));
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
  recordsOf: (runId: string) => readonly ModelCallRecord[];
  fetchPage: (runIds: readonly string[], cursor: BilledCallsCursorView, limit: number) => Promise<BilledCallsPageView>;
  sideTimingsOf?: (runId: string) => readonly SideTiming[];
  runlessTimingsOf?: () => readonly SideTiming[];
  pageSize?: number;
};

export const costBreakdownOf = async (sources: CostBreakdownSources): Promise<{ breakdown: CostBreakdown; text: string }> => {
  const { runIds } = sources;
  const billed: BilledCallView[] = [];
  let cursor: BilledCallsCursorView | undefined = { run: 0, after: 0 };
  while (cursor !== undefined) {
    const page: BilledCallsPageView = await sources.fetchPage(runIds, cursor, sources.pageSize ?? MAX_BILLED_CALLS_PAGE);
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
  const joined = runIds.map((runId) =>
    joinRunCalls(
      runId,
      billed.filter((call) => call.runId === runId),
      sources.recordsOf(runId),
      sources.sideTimingsOf === undefined ? [] : sources.sideTimingsOf(runId),
    ),
  );
  const runlessTimings = new Map((sources.runlessTimingsOf === undefined ? [] : sources.runlessTimingsOf()).map((entry) => [entry.responseId, entry.timing]));
  const runless = billed
    .filter((call) => call.runId === RUNLESS)
    .map((call) => {
      const timing = call.responseId === undefined ? undefined : runlessTimings.get(call.responseId);
      return breakdownCallOf(call, timing === undefined ? {} : { timing });
    });
  const breakdown = buildCostBreakdown(
    [...joined.flatMap((entry) => entry.calls), ...runless],
    { unjoined: joined.flatMap((entry) => entry.unjoined), callsWithoutResponseId: joined.reduce((sum, entry) => sum + entry.withoutResponseId, 0) },
  );
  return { breakdown, text: formatCostBreakdown(breakdown) };
};
