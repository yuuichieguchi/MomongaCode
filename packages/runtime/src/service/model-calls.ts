import { MAX_BILLED_CALLS_PAGE, RUNLESS, RUN_ROLE, buildCostBreakdown, formatCostBreakdown } from '@momonga/observability';
import type { BreakdownCall, CostBreakdown, UnjoinedRecord } from '@momonga/observability';
import type { BilledCallsCursorView, BilledCallsPageView, BilledCallView, RunTraceCall } from '@momonga/protocol';
import type { ModelCallRecord } from '@momonga/store';

export const traceCallsOf = (records: readonly ModelCallRecord[]): RunTraceCall[] =>
  records.flatMap((record) =>
    record.kind === 'requested' ? [{ step: record.step, attempt: record.attempt, ...(record.anatomy === undefined ? {} : { anatomy: record.anatomy }) }] : [],
  );

type Response = Pick<BreakdownCall, 'anatomy' | 'timing'> & { step: number };

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
    responses.push({ step: record.step, ...(anatomy === undefined ? {} : { anatomy }), ...(record.timing === undefined ? {} : { timing: record.timing }) });
  }
  return responses;
};

const breakdownCallOf = (call: BilledCallView, joined: Partial<Response>): BreakdownCall => ({
  runId: call.runId,
  ...(call.step === undefined ? {} : { step: call.step }),
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

export const joinRunCalls = (runId: string, billed: readonly BilledCallView[], records: readonly ModelCallRecord[]): { calls: BreakdownCall[]; unjoined: UnjoinedRecord[] } => {
  const responses = responsesOf(records);
  const calls: BreakdownCall[] = billed.filter((call) => !isMain(call)).map((call) => breakdownCallOf(call, {}));
  const unjoined: UnjoinedRecord[] = [];
  const main = billed.filter(isMain);
  const steps = [...new Set([...main.map((call) => call.step), ...responses.map((response) => response.step)])];
  for (const step of steps) {
    const spans = main.filter((call) => call.step === step);
    const answers = responses.filter((response) => response.step === step);
    const stepField = step === undefined ? {} : { step };
    spans.forEach((span, index) => {
      calls.push(breakdownCallOf(span, answers[index] ?? {}));
      if (answers[index] === undefined) unjoined.push({ runId, ...stepField, reason: 'a billed model call has no recorded model response' });
    });
    for (const _extra of answers.slice(spans.length)) {
      unjoined.push({ runId, ...stepField, reason: 'a recorded model response has no billed model call' });
    }
  }
  return { calls, unjoined };
};

export type CostBreakdownSources = {
  runIds: readonly string[];
  recordsOf: (runId: string) => readonly ModelCallRecord[];
  fetchPage: (runIds: readonly string[], cursor: BilledCallsCursorView, limit: number) => Promise<BilledCallsPageView>;
  pageSize?: number;
};

export const costBreakdownOf = async (sources: CostBreakdownSources): Promise<{ breakdown: CostBreakdown; text: string }> => {
  const { runIds } = sources;
  const billed: BilledCallView[] = [];
  let cursor: BilledCallsCursorView | undefined = { run: 0, offset: 0 };
  while (cursor !== undefined) {
    const page: BilledCallsPageView = await sources.fetchPage(runIds, cursor, sources.pageSize ?? MAX_BILLED_CALLS_PAGE);
    billed.push(...page.calls);
    cursor = page.next;
  }
  const joined = runIds.map((runId) =>
    joinRunCalls(
      runId,
      billed.filter((call) => call.runId === runId),
      sources.recordsOf(runId),
    ),
  );
  const runless = billed.filter((call) => call.runId === RUNLESS).map((call) => breakdownCallOf(call, {}));
  const breakdown = buildCostBreakdown(
    [...joined.flatMap((entry) => entry.calls), ...runless],
    { unjoined: joined.flatMap((entry) => entry.unjoined) },
  );
  return { breakdown, text: formatCostBreakdown(breakdown) };
};
