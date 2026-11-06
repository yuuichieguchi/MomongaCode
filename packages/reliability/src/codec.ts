import { parseOutsideJson } from '@momonga/foundation';
import { RELIABILITY_FORMAT } from '@momonga/protocol';
import { GROUP_KEYS } from './types.ts';
import type { Indicators } from './types.ts';
import { REPORT_KINDS } from './report.ts';
import type { Harness, ReliabilityReport, ReportKind as ReportKindName, ScenarioRow, TaskRow } from './report.ts';

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

const rateAt = (value: unknown, path: string): { k: number; n: number } => {
  const fields = fieldsAt(value, path);
  return { k: countAt(fields, 'k', path), n: countAt(fields, 'n', path) };
};

const decodeIndicators = (value: unknown, path: string): Indicators => {
  const fields = fieldsAt(value, path);
  const buckets = fieldsAt(fields['buckets'], `${path}.buckets`);
  const completion = fieldsAt(fields['completion'], `${path}.completion`);
  const recovery = fieldsAt(fields['recovery'], `${path}.recovery`);
  const recoveryTime = fieldsAt(fields['recoveryTime'], `${path}.recoveryTime`);
  const duplicates = fieldsAt(fields['duplicates'], `${path}.duplicates`);
  const overrun = fieldsAt(fields['overrun'], `${path}.overrun`);
  const time = fieldsAt(fields['time'], `${path}.time`);
  return {
    buckets: {
      counted: countAt(buckets, 'counted', `${path}.buckets`),
      cancelled: countAt(buckets, 'cancelled', `${path}.buckets`),
      pendingFacts: countAt(buckets, 'pendingFacts', `${path}.buckets`),
    },
    completion: {
      k: countAt(completion, 'k', `${path}.completion`),
      n: countAt(completion, 'n', `${path}.completion`),
      undeclared: countAt(completion, 'undeclared', `${path}.completion`),
    },
    recovery: {
      k: countAt(recovery, 'k', `${path}.recovery`),
      n: countAt(recovery, 'n', `${path}.recovery`),
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
      k: countAt(overrun, 'k', `${path}.overrun`),
      n: countAt(overrun, 'n', `${path}.overrun`),
      budgetStops: countAt(overrun, 'budgetStops', `${path}.overrun`),
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
    const met = countAt(row, 'met', path);
    if (met > trials) fail(`${path}.met`, `at most trials (${trials})`);
    return { task: textAt(row, 'task', path), trials, met, difficulty: textAt(row, 'difficulty', path), taskType: textAt(row, 'taskType', path) };
  });

const decodeScenarios = (value: unknown): ScenarioRow[] =>
  listAt(value, 'report.scenarios').map((entry, index) => {
    const path = `report.scenarios[${index}]`;
    const row = fieldsAt(entry, path);
    const episodes = countAt(row, 'episodes', path);
    const recovered = countAt(row, 'recovered', path);
    if (recovered > episodes) fail(`${path}.recovered`, `at most episodes (${episodes})`);
    return { scenario: textAt(row, 'scenario', path), trials: countAt(row, 'trials', path), episodes, recovered };
  });

const decodeWitnessed = (value: unknown): { k: number; n: number } => {
  const rate = rateAt(value, 'report.witnessed');
  if (rate.k > rate.n) fail('report.witnessed.k', `at most n (${rate.n})`);
  return rate;
};

export const encodeReliabilityReport = (report: ReliabilityReport): string => JSON.stringify(report);

export const decodeReliabilityReport = (text: string): ReliabilityReport => {
  const fields = fieldsAt(parseOutsideJson(text), 'report');
  if (fields['format'] !== RELIABILITY_FORMAT) {
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
  const rowsOnlyFor = (key: string, owner: ReportKindName): void => {
    if (fields[key] !== undefined && kind !== owner) fail(`report.${key}`, `absent from a ${kind} report`);
  };
  rowsOnlyFor('tasks', 'benchmark');
  rowsOnlyFor('scenarios', 'injection');
  rowsOnlyFor('witnessed', 'injection');
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
    ...(fields['witnessed'] === undefined ? {} : { witnessed: decodeWitnessed(fields['witnessed']) }),
  };
};
