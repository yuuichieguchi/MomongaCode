import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELIABILITY_FORMAT } from '@momonga/protocol';
import { titleOf } from './support/cases.ts';

const SCENARIOS_FILE = path.join(import.meta.dirname, 'inject', 'scenarios.json');
const RUNNER = './support/inject-runner.ts';

type Scenario = { id: string; fault: string; requires: 'any' | 'linux-container'; effect?: string; expect: Record<string, unknown> };

type ScenarioResult =
  | { id: string; status: 'ran'; witness: Record<string, number>; outcomes: string[] }
  | { id: string; status: 'not_run'; reason: string };

type InjectionRunner = {
  runInjectionScenario(scenario: Scenario, host: { linuxContainer: boolean }): Promise<ScenarioResult[]>;
  injectionReportOf(results: readonly ScenarioResult[]): { format: string; kind: string; population: { notRun: { id: string; reason: string }[] } };
};

const scenarios = (): Scenario[] => {
  const file = JSON.parse(fs.readFileSync(SCENARIOS_FILE, 'utf8')) as { format: string; scenarios: Scenario[] };
  expect(file.format).toBe('momonga-inject/1');
  return file.scenarios;
};

const runner = async (): Promise<InjectionRunner> => (await import(RUNNER)) as InjectionRunner;

const INJECT_TIMEOUT_MS = 1_800_000;

describe('the injection scenario set (4.1, 4.3)', () => {
  it(titleOf('inject-faults'), () => {
    const all = scenarios();
    expect(new Set(all.map((scenario) => scenario.fault)).size).toBe(10);
    expect(new Set(all.map((scenario) => scenario.id)).size).toBe(all.length);
    expect(all.filter((scenario) => scenario.requires === 'linux-container')).toHaveLength(1);
  });

  it(titleOf('inject-p9'), { timeout: INJECT_TIMEOUT_MS }, async () => {
    const { runInjectionScenario } = await runner();
    const results: ScenarioResult[] = [];
    for (const scenario of scenarios().filter((candidate) => candidate.requires === 'any')) results.push(...(await runInjectionScenario(scenario, { linuxContainer: false })));
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.status, result.id).toBe('ran');
      if (result.status === 'ran') for (const [key, count] of Object.entries(result.witness)) expect(count, `${result.id} ${key}`).toBeLessThanOrEqual(1);
    }
  });

  it(titleOf('inject-not-run'), async () => {
    const { injectionReportOf, runInjectionScenario } = await runner();
    const diskFull = scenarios().find((scenario) => scenario.requires === 'linux-container');
    expect(diskFull).toBeDefined();
    const results = await runInjectionScenario(diskFull as Scenario, { linuxContainer: false });
    expect(results).toEqual([{ id: (diskFull as Scenario).id, status: 'not_run', reason: expect.stringMatching(/linux-container/) }]);
    const report = injectionReportOf(results);
    expect(report).toMatchObject({ format: RELIABILITY_FORMAT, kind: 'injection' });
    expect(report.population.notRun).toEqual([{ id: (diskFull as Scenario).id, reason: expect.stringMatching(/linux-container/) }]);
  });
});
