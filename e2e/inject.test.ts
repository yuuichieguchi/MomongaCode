import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELIABILITY_FORMAT } from '@momonga/protocol';
import { titleOf } from './support/cases.ts';
import { expectRan, scenarioNamed } from './support/inject-files.ts';
import { injectionReportOf, injectionScenarios } from './support/inject-report.ts';
import { declaredPointsOf, detectInjectionHost, pointIdOf, runInjectionScenario, scenarioBoundMs } from './support/inject-runner.ts';

const SCENARIO_DIR = path.join(import.meta.dirname, 'inject');

const HOST = detectInjectionHost();

const SCENARIO_CALL = /^injectionScenarioFile\('([^']+)'\);$/m;
const POINT_CALL = /^injectionPointFile\('([^']+)', '(model\.requested|tool\.started)', (\d+)\);$/m;
const REFERENCE_CALL = /^injectionReferenceFile\('([^']+)'\);$/m;

const filesOfScenarios = (): { scenarios: string[]; points: string[]; references: string[] } => {
  const texts = fs.readdirSync(SCENARIO_DIR).filter((name) => name.endsWith('.test.ts')).map((name) => fs.readFileSync(path.join(SCENARIO_DIR, name), 'utf8'));
  return {
    scenarios: texts.flatMap((text) => SCENARIO_CALL.exec(text)?.[1] ?? []),
    points: texts.flatMap((text) => {
      const match = POINT_CALL.exec(text);
      return match === null ? [] : [pointIdOf(scenarioNamed(match[1] as string), { type: match[2] as 'model.requested' | 'tool.started', occurrence: Number(match[3]) })];
    }),
    references: texts.flatMap((text) => REFERENCE_CALL.exec(text)?.[1] ?? []),
  };
};

describe('the injection scenario set (4.1, 4.3)', () => {
  it(titleOf('inject-faults'), () => {
    const all = injectionScenarios.scenarios;
    expect(injectionScenarios.format).toBe('momonga-inject/1');
    expect(new Set(all.map((scenario) => scenario.fault)).size).toBe(11);
    expect(new Set(all.map((scenario) => scenario.id)).size).toBe(all.length);
    expect(all.filter((scenario) => scenario.requires === 'linux-container')).toHaveLength(1);
  });

  describe(titleOf('inject-p9'), () => {
    it('is run by the files of e2e/inject: one file for each scenario that can run on this host, and for a scenario of kill points one file for its reference run and one for each point it declares', () => {
      const runnable = injectionScenarios.scenarios.filter((scenario) => scenario.requires === 'any');
      const swept = runnable.filter((scenario) => scenario.fault === 'kill_at_step');
      const files = filesOfScenarios();
      expect([...files.scenarios].sort()).toEqual(runnable.filter((scenario) => scenario.fault !== 'kill_at_step').map((scenario) => scenario.id).sort());
      expect([...files.references].sort()).toEqual(swept.map((scenario) => scenario.id).sort());
      expect([...files.points].sort()).toEqual(swept.flatMap((scenario) => declaredPointsOf(scenario).map((point) => pointIdOf(scenario, point))).sort());
    });
  });

  it.skipIf(HOST.linuxContainer)(titleOf('inject-not-run'), async () => {
    const diskFull = injectionScenarios.scenarios.find((scenario) => scenario.requires === 'linux-container');
    if (diskFull === undefined) throw new Error('the scenario set holds no scenario for the Linux container');
    const results = await runInjectionScenario(diskFull, HOST);
    expect(results).toEqual([{ id: diskFull.id, status: 'not_run', reason: expect.stringMatching(/linux-container/) }]);
    const report = injectionReportOf(results);
    expect(report).toMatchObject({ format: RELIABILITY_FORMAT, kind: 'injection' });
    expect(report.population.notRun).toEqual([{ id: diskFull.id, reason: expect.stringMatching(/linux-container/) }]);
  });

  it.runIf(HOST.linuxContainer)('P9: the out-of-disk scenario runs on the size-limited volume of the Linux container', { timeout: scenarioBoundMs(scenarioNamed('disk-full')) }, async () => {
    expectRan(await runInjectionScenario(scenarioNamed('disk-full'), HOST));
  });
});
