import { parseOutsideJson } from '@momonga/foundation';
import { COST_CURRENCY, RELIABILITY_FORMAT, RETIRED_RELIABILITY_FORMATS } from '@momonga/protocol';
import type { Period } from './aggregate.ts';
import type { CostGroups, CostIndicators, CostSide } from './cost.ts';
import { GROUP_KEYS } from './types.ts';
import type { Indicators } from './types.ts';
import { REPORT_KINDS } from './report.ts';
import type { Harness, NotRun, ReliabilityReport, ReportKind as ReportKindName, ScenarioRow, TaskRow } from './report.ts';

type Fields = Record<string, unknown>;

const fail = (path: string, expected: string): never => {
  throw new TypeError(`${RELIABILITY_FORMAT}: ${path} must be ${expected}`);
};

const fieldsAt = (value: unknown, path: string): Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : fail(path, 'an object');

const countAt = (fields: Fields, key: string, path: string): number => {
  const value = fields[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail(`${path}.${key}`, 'a non-negative integer');
};

const meanAt = (fields: Fields, key: string, path: string): number | null => {
  const value = fields[key];
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fail(`${path}.${key}`, 'a non-negative number or null');
};

const partAt = (fields: Fields, key: string, path: string, whole: { key: string; count: number }): number => {
  const part = countAt(fields, key, path);
  return part <= whole.count ? part : fail(`${path}.${key}`, `at most ${whole.key} (${whole.count})`);
};

const rateOf = (fields: Fields, path: string): { k: number; n: number } => {
  const n = countAt(fields, 'n', path);
  return { k: partAt(fields, 'k', path, { key: 'n', count: n }), n };
};

const rateAt = (value: unknown, path: string): { k: number; n: number } => rateOf(fieldsAt(value, path), path);

const decodeIndicators = (value: unknown, path: string): Indicators => {
  const fields = fieldsAt(value, path);
  const buckets = fieldsAt(fields['buckets'], `${path}.buckets`);
  const completion = fieldsAt(fields['completion'], `${path}.completion`);
  const recovery = fieldsAt(fields['recovery'], `${path}.recovery`);
  const recoveryTime = fieldsAt(fields['recoveryTime'], `${path}.recoveryTime`);
  const duplicates = fieldsAt(fields['duplicates'], `${path}.duplicates`);
  const overrun = fieldsAt(fields['overrun'], `${path}.overrun`);
  const time = fieldsAt(fields['time'], `${path}.time`);
  const delegation = fieldsAt(fields['delegation'], `${path}.delegation`);
  const mandateRuns = { key: 'n', count: countAt(delegation, 'n', `${path}.delegation`) };
  return {
    buckets: {
      counted: countAt(buckets, 'counted', `${path}.buckets`),
      cancelled: countAt(buckets, 'cancelled', `${path}.buckets`),
      pendingFacts: countAt(buckets, 'pendingFacts', `${path}.buckets`),
      factsUnavailable: countAt(buckets, 'factsUnavailable', `${path}.buckets`),
      unknownValues: countAt(buckets, 'unknownValues', `${path}.buckets`),
    },
    completion: {
      ...rateOf(completion, `${path}.completion`),
      undeclared: countAt(completion, 'undeclared', `${path}.completion`),
    },
    recovery: {
      ...rateOf(recovery, `${path}.recovery`),
      unknownEffect: countAt(recovery, 'unknownEffect', `${path}.recovery`),
      failed: countAt(recovery, 'failed', `${path}.recovery`),
      stopped: countAt(recovery, 'stopped', `${path}.recovery`),
    },
    recoveryTime: {
      n: countAt(recoveryTime, 'n', `${path}.recoveryTime`),
      meanMs: meanAt(recoveryTime, 'meanMs', `${path}.recoveryTime`),
      medianMs: meanAt(recoveryTime, 'medianMs', `${path}.recoveryTime`),
      clockSkew: countAt(recoveryTime, 'clockSkew', `${path}.recoveryTime`),
    },
    duplicates: {
      journal: rateAt(duplicates['journal'], `${path}.duplicates.journal`),
      prevented: countAt(duplicates, 'prevented', `${path}.duplicates`),
      unknown: countAt(duplicates, 'unknown', `${path}.duplicates`),
    },
    intervention: rateAt(fields['intervention'], `${path}.intervention`),
    overrun: {
      ...rateOf(overrun, `${path}.overrun`),
      budgetStops: countAt(overrun, 'budgetStops', `${path}.overrun`),
      money: rateAt(overrun['money'], `${path}.overrun.money`),
    },
    delegation: {
      n: mandateRuns.count,
      intervened: partAt(delegation, 'intervened', `${path}.delegation`, mandateRuns),
      unattended: partAt(delegation, 'unattended', `${path}.delegation`, mandateRuns),
      waited: countAt(delegation, 'waited', `${path}.delegation`),
      held: countAt(delegation, 'held', `${path}.delegation`),
      denied: countAt(delegation, 'denied', `${path}.delegation`),
    },
    time: {
      n: countAt(time, 'n', `${path}.time`),
      meanActiveMs: meanAt(time, 'meanActiveMs', `${path}.time`),
      meanElapsedMs: meanAt(time, 'meanElapsedMs', `${path}.time`),
    },
  };
};

const textAt = (fields: Fields, key: string, path: string): string => {
  const value = fields[key];
  return typeof value === 'string' && value.length > 0 ? value : fail(`${path}.${key}`, 'a non-empty string');
};

const listAt = (value: unknown, path: string): unknown[] => (Array.isArray(value) ? value : fail(path, 'a list'));

const ANSWER_KINDS = ['model', 'script', 'unknown'] as const;

const decodeHarness = (value: unknown): Harness => {
  const fields = fieldsAt(value, 'report.harness');
  const suite = fieldsAt(fields['suite'], 'report.harness.suite');
  return {
    suite: { name: textAt(suite, 'name', 'report.harness.suite'), digest: textAt(suite, 'digest', 'report.harness.suite') },
    answeredBy: listAt(fields['answeredBy'], 'report.harness.answeredBy').map((entry, index) => {
      const path = `report.harness.answeredBy[${index}]`;
      const answerer = fieldsAt(entry, path);
      const answers = ANSWER_KINDS.find((candidate) => candidate === answerer['answers']);
      if (answers === undefined) return fail(`${path}.answers`, `one of ${ANSWER_KINDS.join(', ')}`);
      return { target: textAt(answerer, 'target', path), adapter: textAt(answerer, 'adapter', path), upstreamModel: textAt(answerer, 'upstreamModel', path), answers };
    }),
    unrecordedAnswers: countAt(fields, 'unrecordedAnswers', 'report.harness'),
    codeDigest: textAt(fields, 'codeDigest', 'report.harness'),
  };
};

const decodeTasks = (value: unknown): TaskRow[] =>
  listAt(value, 'report.tasks').map((entry, index) => {
    const path = `report.tasks[${index}]`;
    const row = fieldsAt(entry, path);
    const trials = countAt(row, 'trials', path);
    const met = partAt(row, 'met', path, { key: 'trials', count: trials });
    return { task: textAt(row, 'task', path), trials, met, difficulty: textAt(row, 'difficulty', path), taskType: textAt(row, 'taskType', path) };
  });

const decodeScenarios = (value: unknown): ScenarioRow[] =>
  listAt(value, 'report.scenarios').map((entry, index) => {
    const path = `report.scenarios[${index}]`;
    const row = fieldsAt(entry, path);
    const episodes = countAt(row, 'episodes', path);
    const recovered = partAt(row, 'recovered', path, { key: 'episodes', count: episodes });
    return { scenario: textAt(row, 'scenario', path), trials: countAt(row, 'trials', path), episodes, recovered };
  });

const decodePopulation = (value: unknown): { notRun: NotRun[] } => {
  const fields = fieldsAt(value, 'report.population');
  return {
    notRun: listAt(fields['notRun'], 'report.population.notRun').map((entry, index) => {
      const path = `report.population.notRun[${index}]`;
      const row = fieldsAt(entry, path);
      return { id: textAt(row, 'id', path), reason: textAt(row, 'reason', path) };
    }),
  };
};

const decodePeriod = (value: unknown): Period => {
  const fields = fieldsAt(value, 'report.period');
  return { days: countAt(fields, 'days', 'report.period'), fromMs: countAt(fields, 'fromMs', 'report.period'), toMs: countAt(fields, 'toMs', 'report.period') };
};

const UNITS = /^[0-9]+$/;

const decodeCostSide = (value: unknown, path: string): CostSide => {
  const fields = fieldsAt(value, path);
  return {
    tasks: countAt(fields, 'tasks', path),
    fullyPriced: countAt(fields, 'fullyPriced', path),
    calls: countAt(fields, 'calls', path),
    notPriced: countAt(fields, 'notPriced', path),
    tokens: countAt(fields, 'tokens', path),
    ...(fields['legacyPrecisionCalls'] === undefined ? {} : { legacyPrecisionCalls: countAt(fields, 'legacyPrecisionCalls', path) }),
    priced: listAt(fields['priced'], `${path}.priced`).map((entry, index) => {
      const at = `${path}.priced[${index}]`;
      const amount = fieldsAt(entry, at);
      if (amount['currency'] !== COST_CURRENCY) fail(`${at}.currency`, COST_CURRENCY);
      const units = textAt(amount, 'units', at);
      if (!UNITS.test(units)) fail(`${at}.units`, 'a non-negative integer in decimal digits');
      return { currency: COST_CURRENCY, priceVersion: textAt(amount, 'priceVersion', at), units };
    }),
  };
};

const decodeCostIndicators = (value: unknown, path: string): CostIndicators => {
  const fields = fieldsAt(value, path);
  return { successful: decodeCostSide(fields['successful'], `${path}.successful`), unsuccessful: decodeCostSide(fields['unsuccessful'], `${path}.unsuccessful`) };
};

const decodeCost = (value: unknown): CostGroups => {
  const fields = fieldsAt(value, 'report.cost');
  const groups = fieldsAt(fields['groups'], 'report.cost.groups');
  return {
    total: decodeCostIndicators(fields['total'], 'report.cost.total'),
    groups: Object.fromEntries(Object.entries(groups).map(([name, indicators]) => [name, decodeCostIndicators(indicators, `report.cost.groups.${name}`)])),
  };
};

export const encodeReliabilityReport = (report: ReliabilityReport): string => JSON.stringify(report);

export const decodeReliabilityReport = (text: string): ReliabilityReport => {
  const fields = fieldsAt(parseOutsideJson(text), 'report');
  const format = fields['format'];
  if (typeof format === 'string' && Object.hasOwn(RETIRED_RELIABILITY_FORMATS, format)) {
    throw new TypeError(`${format} reports do not record ${RETIRED_RELIABILITY_FORMATS[format]}, so ${format} is retired; rebuild the report as ${RELIABILITY_FORMAT}`);
  }
  if (format !== RELIABILITY_FORMAT) {
    throw new TypeError(`${RELIABILITY_FORMAT}: the report declares format ${JSON.stringify(fields['format'])}, which is not supported`);
  }
  const kind = REPORT_KINDS.find((candidate) => candidate === fields['kind']);
  if (kind === undefined) return fail('report.kind', `one of ${REPORT_KINDS.join(', ')}`);
  const groupBy = GROUP_KEYS.find((candidate) => candidate === fields['groupBy']);
  if (groupBy === undefined) return fail('report.groupBy', `one of ${GROUP_KEYS.join(', ')}`);
  const groups = fieldsAt(fields['groups'], 'report.groups');
  const harness = fields['harness'];
  if (kind === 'real' ? harness !== null : harness === null || harness === undefined) {
    return fail('report.harness', kind === 'real' ? 'null for a real report' : `present for a ${kind} report`);
  }
  const rowsOnlyFor = (key: string, ...owners: ReportKindName[]): void => {
    if (fields[key] !== undefined && !owners.includes(kind)) fail(`report.${key}`, `absent from a ${kind} report`);
  };
  rowsOnlyFor('tasks', 'benchmark');
  rowsOnlyFor('scenarios', 'injection');
  rowsOnlyFor('witnessed', 'injection');
  rowsOnlyFor('population', 'injection', 'benchmark');
  rowsOnlyFor('period', 'real');
  rowsOnlyFor('cost', 'real', 'benchmark');
  return {
    format: RELIABILITY_FORMAT,
    kind,
    definitionsVersion: countAt(fields, 'definitionsVersion', 'report'),
    groupBy,
    total: decodeIndicators(fields['total'], 'report.total'),
    groups: Object.fromEntries(Object.entries(groups).map(([name, indicators]) => [name, decodeIndicators(indicators, `report.groups.${name}`)])),
    harness: harness === null ? null : decodeHarness(harness),
    ...(fields['tasks'] === undefined ? {} : { tasks: decodeTasks(fields['tasks']) }),
    ...(fields['scenarios'] === undefined ? {} : { scenarios: decodeScenarios(fields['scenarios']) }),
    ...(fields['witnessed'] === undefined ? {} : { witnessed: rateAt(fields['witnessed'], 'report.witnessed') }),
    ...(fields['population'] === undefined ? {} : { population: decodePopulation(fields['population']) }),
    ...(fields['period'] === undefined ? {} : { period: decodePeriod(fields['period']) }),
    ...(fields['cost'] === undefined ? {} : { cost: decodeCost(fields['cost']) }),
  };
};
