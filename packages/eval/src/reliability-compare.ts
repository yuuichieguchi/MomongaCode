import { escapeTerminalLine } from '@momonga/protocol';
import type { Harness, ReliabilityReport, ReportKind } from '@momonga/reliability';
import { MINIMUM_PAIRS, pairedBootstrap } from './bootstrap.ts';
import type { BootstrapInterval } from './bootstrap.ts';
import { NO_MEASURE, answererTerm, describeInterval, gateLines } from './context-compare.ts';
import type { GateCheck, GateCheckName } from './context-compare.ts';
import { EvalError } from './runner.ts';

type Unit = { id: string; numerator: number; denominator: number };

type Side = { report: ReliabilityReport; harness: Harness };

type Pairing = { baseline: Side; candidate: Side; seed: number };

type Term = (pairing: Pairing) => GateCheck;

type KindRow = {
  unit: string;
  requireModel: boolean;
  unitsOf(report: ReliabilityReport): readonly Unit[];
  terms: readonly Term[];
};

const unitsOrRefuse = <T>(rows: readonly T[] | undefined, what: string, label: string): readonly T[] => {
  if (rows === undefined) throw new EvalError(`the ${label} report carries no ${what}, so it cannot be paired`);
  return rows;
};

const rateTerm =
  (name: GateCheckName, unit: string, unitsOf: KindRow['unitsOf']): Term =>
  ({ baseline, candidate, seed }) => {
    const before = new Map(unitsOf(baseline.report).map((entry) => [entry.id, entry]));
    const differences = unitsOf(candidate.report).flatMap((entry) => {
      const other = before.get(entry.id);
      if (other === undefined) throw new EvalError(`${unit} ${entry.id} is missing from the baseline report, so the reports cannot be paired`);
      return entry.denominator > 0 && other.denominator > 0 ? [entry.numerator / entry.denominator - other.numerator / other.denominator] : [];
    });
    if (differences.length < MINIMUM_PAIRS) {
      return { name, passed: false, detail: `${NO_MEASURE}: ${differences.length} ${unit}(s) measure it in both reports, and ${MINIMUM_PAIRS} are needed for a real interval` };
    }
    const interval: BootstrapInterval = pairedBootstrap(differences, { seed });
    return {
      name,
      passed: !(interval.high < 0),
      detail: `paired difference ${describeInterval(interval, 3)}; the candidate is worse only when the whole interval lies below 0`,
    };
  };

const witnessedTerm: Term = ({ candidate }) => {
  const name = 'witnessedDuplicates';
  const { witnessed } = candidate.report;
  if (witnessed === undefined || witnessed.n === 0) return { name, passed: false, detail: `${NO_MEASURE}: the candidate report holds no witnessed trial` };
  return { name, passed: witnessed.k === 0, detail: `${witnessed.k} of ${witnessed.n} witnessed trials of the candidate duplicated an effect; the candidate must have none` };
};

const notRunTerm: Term = ({ baseline, candidate }) => {
  const missing = [
    ...(baseline.report.population?.notRun ?? []).map((entry) => `baseline ${entry.id} (${entry.reason})`),
    ...(candidate.report.population?.notRun ?? []).map((entry) => `candidate ${entry.id} (${entry.reason})`),
  ];
  return {
    name: 'notRun',
    passed: missing.length === 0,
    detail: missing.length === 0 ? 'every unit of both reports ran' : `${missing.length} unit(s) did not run, so the reports do not measure the whole suite: ${missing.join('; ')}`,
  };
};

const taskUnits: KindRow['unitsOf'] = (report) =>
  unitsOrRefuse(report.tasks, 'per-task rows', 'benchmark').map((row) => ({ id: row.task, numerator: row.met, denominator: row.trials }));

const scenarioUnits: KindRow['unitsOf'] = (report) =>
  unitsOrRefuse(report.scenarios, 'per-scenario rows', 'injection').map((row) => ({ id: row.scenario, numerator: row.recovered, denominator: row.episodes }));

const KIND_ROWS: Record<Exclude<ReportKind, 'real'>, KindRow> = {
  benchmark: { unit: 'task', requireModel: true, unitsOf: taskUnits, terms: [rateTerm('completionRate', 'task', taskUnits)] },
  injection: { unit: 'scenario', requireModel: false, unitsOf: scenarioUnits, terms: [rateTerm('recoveryRate', 'scenario', scenarioUnits), witnessedTerm] },
};

export type ReliabilityComparison = {
  gateName: 'reliability';
  kind: Exclude<ReportKind, 'real'>;
  baseline: Harness;
  candidate: Harness;
  gate: { passed: boolean; checks: GateCheck[] };
};

const sideOf = (label: string, report: ReliabilityReport): Side => {
  if (report.harness === null) throw new EvalError(`the ${label} report is a ${report.kind} report with no harness, and only benchmark and injection reports can be compared`);
  return { report, harness: report.harness };
};

const assertUnique = (row: KindRow, label: string, report: ReliabilityReport): void => {
  const seen = new Set<string>();
  for (const unit of row.unitsOf(report)) {
    if (seen.has(unit.id)) throw new EvalError(`${row.unit} ${unit.id} appears twice in the ${label} report`);
    seen.add(unit.id);
  }
};

const assertPaired = (row: KindRow, baseline: ReliabilityReport, candidate: ReliabilityReport): void => {
  const before = new Set(row.unitsOf(baseline).map((unit) => unit.id));
  const after = new Set(row.unitsOf(candidate).map((unit) => unit.id));
  const missing = [
    ...[...before].filter((id) => !after.has(id)).map((id) => `${row.unit} ${id} is missing from the candidate report`),
    ...[...after].filter((id) => !before.has(id)).map((id) => `${row.unit} ${id} is missing from the baseline report`),
  ];
  if (missing.length > 0) throw new EvalError(`${missing.join('; ')}, so the reports cannot be paired`);
};

export const compareReliability = (baseline: ReliabilityReport, candidate: ReliabilityReport, options: { seed: number }): ReliabilityComparison => {
  if (baseline.kind !== candidate.kind) throw new EvalError(`the reports are of different kinds (${baseline.kind} and ${candidate.kind}), and only two reports of one kind can be compared`);
  const { kind } = baseline;
  if (kind === 'real') throw new EvalError('a real report is derived from the journal and has no suite to pair; only benchmark and injection reports can be compared');
  const before = sideOf('baseline', baseline);
  const after = sideOf('candidate', candidate);
  if (before.harness.suite.digest !== after.harness.suite.digest) {
    throw new EvalError(`the reports measure different suites (their digests ${before.harness.suite.digest} and ${after.harness.suite.digest} differ), so a difference between them says nothing about the candidate`);
  }
  if (before.harness.codeDigest === after.harness.codeDigest) {
    throw new EvalError('the reports record an identical code digest, so nothing differs between them to measure; compare the code of main against the head');
  }
  const row = KIND_ROWS[kind];
  assertUnique(row, 'baseline', baseline);
  assertUnique(row, 'candidate', candidate);
  assertPaired(row, baseline, candidate);
  const pairing: Pairing = { baseline: before, candidate: after, seed: options.seed };
  const checks = [answererTerm(before.harness, after.harness, row.requireModel), notRunTerm(pairing), ...row.terms.map((term) => term(pairing))];
  return { gateName: 'reliability', kind, baseline: before.harness, candidate: after.harness, gate: { passed: checks.every((check) => check.passed), checks } };
};

export const formatReliabilityComparison = (comparison: ReliabilityComparison): string =>
  [
    `baseline: ${comparison.kind} suite ${comparison.baseline.suite.name} (${comparison.baseline.suite.digest}), codeDigest ${comparison.baseline.codeDigest}`,
    `candidate: ${comparison.kind} suite ${comparison.candidate.suite.name} (${comparison.candidate.suite.digest}), codeDigest ${comparison.candidate.codeDigest}`,
    ...gateLines(comparison),
  ]
    .map(escapeTerminalLine)
    .join('\n');
