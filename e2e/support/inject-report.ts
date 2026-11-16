import fs from 'node:fs';
import path from 'node:path';
import { codeDigestOfRunningProcess } from '@momonga/foundation';
import { buildInjectionReport, parseInjectionScenarios } from '@momonga/eval';
import type { InjectionTrial } from '@momonga/eval';
import { encodeReliabilityReport } from '@momonga/reliability';
import type { ReliabilityReport } from '@momonga/reliability';

export type ScenarioResult =
  | { id: string; status: 'ran'; witness: Record<string, number>; outcomes: string[]; trials: InjectionTrial[] }
  | { id: string; status: 'not_run'; reason: string };

export const INJECTION_REPORT_ENV = 'MOMONGA_INJECTION_REPORT';

const SCENARIOS_FILE = path.join(import.meta.dirname, '..', 'inject', 'scenarios.json');

export const injectionScenarios = parseInjectionScenarios(fs.readFileSync(SCENARIOS_FILE, 'utf8'), SCENARIOS_FILE);

const codeDigest = await codeDigestOfRunningProcess();

export type InjectionReport = ReliabilityReport & { population: { notRun: { id: string; reason: string }[] } };

export const injectionReportOf = (results: readonly ScenarioResult[]): InjectionReport => {
  const report = buildInjectionReport({
    scenarios: injectionScenarios,
    trials: results.flatMap((result) => (result.status === 'ran' ? result.trials : [])),
    notRun: results.flatMap((result) => (result.status === 'not_run' ? [{ id: result.id, reason: result.reason }] : [])),
    codeDigest,
    groupBy: 'model',
  });
  return report as InjectionReport;
};

export const injectionPartsDirOf = (target: string): string => `${target}.parts`;

export const openInjectionParts = (target: string): void => {
  const dir = injectionPartsDirOf(target);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
};

const PART_SUFFIX = '.json';

export const writeInjectionPart = (target: string, results: readonly ScenarioResult[]): void => {
  const first = results[0];
  if (first === undefined) throw new Error('an injection part holds the results of one scenario, and none was given');
  fs.writeFileSync(path.join(injectionPartsDirOf(target), `${first.id}.${process.pid}${PART_SUFFIX}`), JSON.stringify(results), { mode: 0o600, flag: 'wx' });
};

const scenarioOrder = (id: string): number => injectionScenarios.scenarios.findIndex((scenario) => id === scenario.id || id.startsWith(`${scenario.id}@`));

export const assembleInjectionReport = async (target: string): Promise<void> => {
  const dir = injectionPartsDirOf(target);
  const names = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(PART_SUFFIX));
  const parts = await Promise.all(names.map(async (name) => JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8')) as ScenarioResult[]));
  const results = parts.flat().sort((left, right) => scenarioOrder(left.id) - scenarioOrder(right.id));
  fs.writeFileSync(target, `${encodeReliabilityReport(injectionReportOf(results))}\n`);
  fs.rmSync(dir, { recursive: true, force: true });
};
