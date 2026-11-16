import { describe, expect, it } from 'vitest';
import type { InjectionScenario } from '@momonga/eval';
import { titleOf } from './cases.ts';
import { injectionScenarios } from './inject-report.ts';
import type { ScenarioResult } from './inject-report.ts';
import { declaredPointsOf, detectInjectionHost, pointBoundMs, pointIdOf, referenceBoundMs, referencePointsOf, runInjectionPoint, runInjectionScenario, scenarioBoundMs } from './inject-runner.ts';
import type { InjectionPoint } from './inject-runner.ts';

export const scenarioNamed = (id: string): InjectionScenario => {
  const found = injectionScenarios.scenarios.find((scenario) => scenario.id === id);
  if (found === undefined) throw new Error(`the scenario set holds no scenario ${id}`);
  return found;
};

export const expectRan = (results: readonly ScenarioResult[]): void => {
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) {
    expect(result.status, result.id).toBe('ran');
    if (result.status === 'ran') for (const [key, count] of Object.entries(result.witness)) expect(count, `${result.id} ${key}`).toBeLessThanOrEqual(1);
  }
};

export const injectionScenarioFile = (id: string): void => {
  const scenario = scenarioNamed(id);
  describe(titleOf('inject-p9'), () => {
    it(id, { timeout: scenarioBoundMs(scenario) }, async () => {
      expectRan(await runInjectionScenario(scenario, detectInjectionHost()));
    });
  });
};

export const injectionPointFile = (id: string, type: InjectionPoint['type'], occurrence: number): void => {
  const scenario = scenarioNamed(id);
  const point = { type, occurrence };
  describe(titleOf('inject-p9'), () => {
    it(pointIdOf(scenario, point), { timeout: pointBoundMs(scenario) }, async () => {
      expect(declaredPointsOf(scenario)).toContainEqual(point);
      expectRan(await runInjectionPoint(scenario, point));
    });
  });
};

export const injectionReferenceFile = (id: string): void => {
  const scenario = scenarioNamed(id);
  describe(titleOf('inject-p9'), () => {
    it(`${id}: the reference run without a fault reaches every point the scenario declares, and no other`, { timeout: referenceBoundMs(scenario) }, async () => {
      expect(await referencePointsOf(scenario)).toEqual(declaredPointsOf(scenario));
    });
  });
};
