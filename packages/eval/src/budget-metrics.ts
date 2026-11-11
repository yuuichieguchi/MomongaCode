import { TERMINAL_STATUSES, heldEndOf, nanoOfAmount, nanoOfCost } from '@momonga/protocol';
import type { BudgetCause, BudgetDimension, PublicRunEvent, RecordedModelCost } from '@momonga/protocol';
import type { GoldenCase } from './dataset.ts';
import { gateVerdictOf } from './oracle.ts';
import { proportionOf } from './stats.ts';
import type { Proportion } from './stats.ts';
import type { RecordedRun } from './transcript.ts';

export type BudgetStop = { dimension: BudgetDimension; cause: BudgetCause; spent: number; limit: number };

export type RunBudgetFacts = {
  limits: { tokens?: number; costNano?: number };
  spent: { tokens: number; costNano: number; unpricedCalls: number };
  gatePassed: boolean;
  stops: BudgetStop[];
};

export type RunMandateFacts = {
  terminal: boolean;
  completed: boolean;
  approvalTimeout: boolean;
  waitedForPerson: boolean;
  held: number;
  resolvedByPerson: number;
  deniedOutsideMandate: number;
  blockedByHeldCall: number;
  holdLatenciesMs: number[];
  workDuringHolds: { modelSteps: number; toolCalls: number };
};

export type RunFiguresOfEval = { budget: RunBudgetFacts; mandate?: RunMandateFacts };

const lesser = (left: number | undefined, right: number | undefined): number | undefined => (left === undefined ? right : right === undefined ? left : Math.min(left, right));

const limitsOf = (golden: Pick<GoldenCase, 'limits' | 'mandate'>): RunBudgetFacts['limits'] => {
  const tokens = lesser(golden.limits?.maxTotalTokens, golden.mandate?.budget?.tokens);
  const costUsd = lesser(golden.limits?.maxCostUsd, golden.mandate?.budget?.costUsd);
  return { ...(tokens === undefined ? {} : { tokens }), ...(costUsd === undefined ? {} : { costNano: nanoOfAmount(costUsd) }) };
};

type Billed = { cost?: RecordedModelCost; unpriced?: unknown };

const spendOfEvents = (events: readonly PublicRunEvent[]): RunBudgetFacts['spent'] => {
  const spent = { tokens: 0, costNano: 0, unpricedCalls: 0 };
  const bill = (tokens: number, billed: Billed | undefined): void => {
    spent.tokens += tokens;
    if (billed?.cost !== undefined) spent.costNano += nanoOfCost(billed.cost);
    else if (billed?.unpriced !== undefined) spent.unpricedCalls += 1;
  };
  for (const event of events) {
    if (event.type === 'model.responded') bill(event.response.usage.total_tokens, event.response.momonga);
    if (event.type === 'usage.charged') bill(event.totalTokens, event);
  }
  return spent;
};

const budgetFactsOf = (golden: Pick<GoldenCase, 'limits' | 'mandate'>, transcript: RecordedRun): RunBudgetFacts => {
  const spends = [transcript.events, ...transcript.children.map((child) => child.events)].map(spendOfEvents);
  return {
    limits: limitsOf(golden),
    spent: {
      tokens: spends.reduce((sum, spend) => sum + spend.tokens, 0),
      costNano: spends.reduce((sum, spend) => sum + spend.costNano, 0),
      unpricedCalls: spends.reduce((sum, spend) => sum + spend.unpricedCalls, 0),
    },
    gatePassed: gateVerdictOf(transcript.run, transcript.events) === 'passed',
    stops: transcript.events.flatMap((event) => (event.type === 'budget.exhausted' ? [{ dimension: event.dimension, cause: event.cause, spent: event.spent, limit: event.limit }] : [])),
  };
};

const isMandateRun = (golden: Pick<GoldenCase, 'mandate'>): boolean => golden.mandate?.scope !== undefined || golden.mandate?.profile !== undefined;

const mandateFactsOf = (transcript: RecordedRun): RunMandateFacts => {
  const { run, events } = transcript;
  const heldAt = new Map<string, { seq: number; createdAt: number }>();
  const intervals: { from: number; to: number }[] = [];
  const holdLatenciesMs: number[] = [];
  let resolvedByPerson = 0;
  let deniedOutsideMandate = 0;
  let blockedByHeldCall = 0;
  let waitedForPerson = false;
  for (const event of events) {
    if (event.type === 'tool.held') heldAt.set(event.callId, { seq: event.seq, createdAt: event.createdAt });
    const ended = heldEndOf(event);
    const held = ended === undefined ? undefined : heldAt.get(ended.callId);
    if (ended !== undefined && held !== undefined && 'seq' in event) {
      intervals.push({ from: held.seq, to: event.seq });
      if (ended.outcome !== 'withdrawn') {
        resolvedByPerson += 1;
        holdLatenciesMs.push(event.createdAt - held.createdAt);
      }
    }
    if (event.type === 'tool.completed' && event.denial?.source === 'mandate') deniedOutsideMandate += 1;
    if (event.type === 'tool.completed' && event.denial?.source === 'held') blockedByHeldCall += 1;
    if (event.type === 'run.quiescent' || (event.type === 'run.status' && event.to === 'WAITING_HUMAN')) waitedForPerson = true;
  }
  const resolved = new Set(events.flatMap((event) => heldEndOf(event)?.callId ?? []));
  for (const [callId, held] of heldAt) if (!resolved.has(callId)) intervals.push({ from: held.seq, to: Number.POSITIVE_INFINITY });
  const duringHold = (seq: number): boolean => intervals.some((interval) => seq > interval.from && seq < interval.to);
  return {
    terminal: TERMINAL_STATUSES.some((status) => status === run.status),
    completed: run.status === 'COMPLETED',
    approvalTimeout: run.status === 'STOPPED' && run.stopReason === 'approval_timeout',
    waitedForPerson,
    held: heldAt.size,
    resolvedByPerson,
    deniedOutsideMandate,
    blockedByHeldCall,
    holdLatenciesMs,
    workDuringHolds: {
      modelSteps: events.filter((event) => event.type === 'model.responded' && duringHold(event.seq)).length,
      toolCalls: events.filter((event) => event.type === 'tool.completed' && event.denial === undefined && !heldAt.has(event.callId) && duringHold(event.seq)).length,
    },
  };
};

export const runFiguresOf = (golden: Pick<GoldenCase, 'limits' | 'mandate'>, transcript: RecordedRun): RunFiguresOfEval => ({
  budget: budgetFactsOf(golden, transcript),
  ...(isMandateRun(golden) ? { mandate: mandateFactsOf(transcript) } : {}),
});

export type BudgetMetrics = {
  limitedRuns: number;
  unlimitedRuns: number;
  overrun: Proportion | undefined;
  runsWithUnpricedCalls: number;
  stops: { dimension: BudgetDimension; cause: BudgetCause; count: number }[];
  costPerSuccess: { runs: number; meanNano: number | null };
  unspentShareAtStop: { stops: number; mean: number | null };
};

export type MandateMetrics = {
  runs: number;
  intervention: Proportion | undefined;
  unattended: Proportion | undefined;
  waitedForPerson: Proportion | undefined;
  approvalTimeout: Proportion | undefined;
  held: number;
  deniedOutsideMandate: number;
  deniedOutsideMandatePerRun: number;
  blockedByHeldCall: number;
  workDuringHolds: { modelSteps: number; toolCalls: number };
  holdLatency: { holds: number; meanMs: number | null };
};

const rateOf = (successes: number, trials: number): Proportion | undefined => (trials === 0 ? undefined : proportionOf(successes, trials));

const meanOf = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

const isLimited = (facts: RunBudgetFacts): boolean => facts.limits.tokens !== undefined || facts.limits.costNano !== undefined;

const isOver = (facts: RunBudgetFacts): boolean =>
  (facts.limits.tokens !== undefined && facts.spent.tokens > facts.limits.tokens) || (facts.limits.costNano !== undefined && facts.spent.costNano > facts.limits.costNano);

export const budgetMetricsOf = (runs: readonly RunBudgetFacts[]): BudgetMetrics | undefined => {
  const limited = runs.filter(isLimited);
  const stops = runs.flatMap((facts) => facts.stops);
  if (limited.length === 0 && stops.length === 0) return undefined;
  const counted = new Map<string, { dimension: BudgetDimension; cause: BudgetCause; count: number }>();
  for (const stop of stops) {
    const key = `${stop.dimension} ${stop.cause}`;
    const entry = counted.get(key) ?? { dimension: stop.dimension, cause: stop.cause, count: 0 };
    entry.count += 1;
    counted.set(key, entry);
  }
  const passed = runs.filter((facts) => facts.gatePassed);
  return {
    limitedRuns: limited.length,
    unlimitedRuns: runs.length - limited.length,
    overrun: rateOf(limited.filter(isOver).length, limited.length),
    runsWithUnpricedCalls: runs.filter((facts) => facts.spent.unpricedCalls > 0).length,
    stops: [...counted.entries()].sort(([left], [right]) => (left < right ? -1 : 1)).map(([, entry]) => entry),
    costPerSuccess: { runs: passed.length, meanNano: meanOf(passed.map((facts) => facts.spent.costNano)) },
    unspentShareAtStop: { stops: stops.length, mean: meanOf(stops.map((stop) => Math.max(0, stop.limit - stop.spent) / stop.limit)) },
  };
};

export const mandateMetricsOf = (runs: readonly RunMandateFacts[]): MandateMetrics | undefined => {
  if (runs.length === 0) return undefined;
  const terminal = runs.filter((facts) => facts.terminal);
  const sum = (pick: (facts: RunMandateFacts) => number): number => runs.reduce((total, facts) => total + pick(facts), 0);
  const deniedOutsideMandate = sum((facts) => facts.deniedOutsideMandate);
  const latencies = runs.flatMap((facts) => facts.holdLatenciesMs);
  return {
    runs: runs.length,
    intervention: rateOf(terminal.filter((facts) => facts.resolvedByPerson > 0).length, terminal.length),
    unattended: rateOf(terminal.filter((facts) => facts.completed && facts.held === 0 && !facts.approvalTimeout).length, terminal.length),
    waitedForPerson: rateOf(terminal.filter((facts) => facts.waitedForPerson).length, terminal.length),
    approvalTimeout: rateOf(terminal.filter((facts) => facts.approvalTimeout).length, terminal.length),
    held: sum((facts) => facts.held),
    deniedOutsideMandate,
    deniedOutsideMandatePerRun: deniedOutsideMandate / runs.length,
    blockedByHeldCall: sum((facts) => facts.blockedByHeldCall),
    workDuringHolds: { modelSteps: sum((facts) => facts.workDuringHolds.modelSteps), toolCalls: sum((facts) => facts.workDuringHolds.toolCalls) },
    holdLatency: { holds: latencies.length, meanMs: meanOf(latencies) },
  };
};
