import { COST_CURRENCY, COST_UNIT_DIGITS, LEGACY_PRECISION_TEXT } from '@momonga/protocol';
import type { RunCostView } from '@momonga/protocol';
import { countedTasksOf } from './aggregate.ts';
import type { Aggregate, CountedTask } from './aggregate.ts';

export type CostAmount = { currency: typeof COST_CURRENCY; priceVersion: string; units: string };

export type CostSide = { tasks: number; fullyPriced: number; noData: number; calls: number; notPriced: number; tokens: number; priced: CostAmount[]; legacyPrecisionCalls?: number };

export type CostIndicators = { successful: CostSide; unsuccessful: CostSide };

export type CostGroups = { total: CostIndicators; groups: Record<string, CostIndicators> };

type SideTally = { tasks: number; fullyPriced: number; noData: number; calls: number; notPriced: number; legacyPrecisionCalls: number; tokens: number; units: Map<string, bigint> };

type Tally = { successful: SideTally; unsuccessful: SideTally };

const emptySide = (): SideTally => ({ tasks: 0, fullyPriced: 0, noData: 0, calls: 0, notPriced: 0, legacyPrecisionCalls: 0, tokens: 0, units: new Map() });

const emptyTally = (): Tally => ({ successful: emptySide(), unsuccessful: emptySide() });

const addTask = (side: SideTally, task: CountedTask, costs: ReadonlyMap<string, RunCostView>): void => {
  let notPriced = 0;
  let calls = 0;
  for (const runId of task.runIds) {
    const cost = costs.get(runId);
    if (cost === undefined) throw new RangeError(`the costs hold no entry for run ${runId} of task ${task.rootRunId}`);
    calls += cost.calls;
    side.legacyPrecisionCalls += cost.legacyPrecisionCalls;
    notPriced += cost.notPriced;
    for (const amount of cost.priced) side.units.set(amount.priceVersion, (side.units.get(amount.priceVersion) ?? 0n) + BigInt(amount.units));
  }
  side.tasks += 1;
  side.calls += calls;
  side.notPriced += notPriced;
  if (calls === 0) side.noData += 1;
  else if (notPriced === 0) side.fullyPriced += 1;
  side.tokens += task.tokens;
};

const finishSide = (side: SideTally): CostSide => ({
  tasks: side.tasks,
  fullyPriced: side.fullyPriced,
  noData: side.noData,
  calls: side.calls,
  notPriced: side.notPriced,
  tokens: side.tokens,
  priced: [...side.units].sort(([left], [right]) => (left < right ? -1 : 1)).map(([priceVersion, units]) => ({ currency: COST_CURRENCY, priceVersion, units: units.toString() })),
  ...(side.legacyPrecisionCalls === 0 ? {} : { legacyPrecisionCalls: side.legacyPrecisionCalls }),
});

const finishTally = (tally: Tally): CostIndicators => ({ successful: finishSide(tally.successful), unsuccessful: finishSide(tally.unsuccessful) });

export const costOf = (aggregated: Aggregate, costs: readonly RunCostView[]): CostGroups => {
  const byRun = new Map(costs.map((cost) => [cost.runId, cost]));
  const total = emptyTally();
  const groups = new Map<string, Tally>();
  for (const task of countedTasksOf(aggregated)) {
    let group = groups.get(task.group);
    if (group === undefined) {
      group = emptyTally();
      groups.set(task.group, group);
    }
    for (const tally of [total, group]) addTask(task.met ? tally.successful : tally.unsuccessful, task, byRun);
  }
  return {
    total: finishTally(total),
    groups: Object.fromEntries([...groups].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([name, tally]) => [name, finishTally(tally)])),
  };
};

const UNIT_DIVISOR = 10n ** BigInt(COST_UNIT_DIGITS);

const amountText = (units: bigint): string => {
  const fraction = (units % UNIT_DIVISOR).toString().padStart(COST_UNIT_DIGITS, '0').replace(/0+$/, '');
  return `${COST_CURRENCY} ${units / UNIT_DIVISOR}${fraction === '' ? '' : `.${fraction}`}`;
};

const notPricedText = (side: CostSide): string =>
  `${side.notPriced} of ${side.calls} calls not priced${side.legacyPrecisionCalls === undefined ? '' : `, ${LEGACY_PRECISION_TEXT(side.legacyPrecisionCalls)}`}`;

const noDataText = (side: CostSide): string[] => (side.noData === 0 ? [] : [`without cost data: ${side.noData}`]);

const successfulLine = (side: CostSide): string => {
  if (side.tasks === 0) return 'Cost per Successful Task: not measurable: no successful task';
  const tasks = BigInt(side.tasks - side.noData);
  const amounts = side.priced.map((amount) => `${amountText(BigInt(amount.units) / tasks)} per task (price version ${amount.priceVersion}, total ${amountText(BigInt(amount.units))})`);
  return [
    `Cost per Successful Task: n=${side.tasks}`,
    amounts.length === 0 ? 'no priced call' : amounts.join(', '),
    notPricedText(side),
    ...noDataText(side),
    ...(side.fullyPriced === side.tasks ? [] : [`partial: ${side.fullyPriced} of ${side.tasks} successful tasks fully priced`]),
    `tokens per successful task ${Math.round(side.tokens / side.tasks)}`,
  ].join('; ');
};

const unsuccessfulLine = (side: CostSide): string => {
  if (side.tasks === 0) return 'Cost of tasks that did not succeed: n=0';
  const amounts = side.priced.map((amount) => `${amountText(BigInt(amount.units))} (price version ${amount.priceVersion})`);
  return [`Cost of tasks that did not succeed: n=${side.tasks}`, amounts.length === 0 ? 'no priced call' : `total ${amounts.join(', ')}`, notPricedText(side), ...noDataText(side), `tokens ${side.tokens}`].join('; ');
};

export const costLines = (cost: CostIndicators): string[] => [successfulLine(cost.successful), unsuccessfulLine(cost.unsuccessful)];
