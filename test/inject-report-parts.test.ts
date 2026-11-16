import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir } from '@momonga/testkit';
import { assembleInjectionReport, injectionPartsDirOf, injectionReportOf, openInjectionParts, writeInjectionPart } from '../e2e/support/inject-report.ts';
import type { ScenarioResult } from '../e2e/support/inject-report.ts';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const targetIn = (): string => {
  const dir = createTempDir();
  made.push(dir);
  return path.join(dir, 'injection.json');
};

const notRun = (id: string): ScenarioResult => ({ id, status: 'not_run', reason: `${id} needs the linux-container` });

describe('the injection report of a run whose scenarios ran in several files', () => {
  it('holds the results of every file, in the order of the scenario set, whatever order the files finished in', async () => {
    const target = targetIn();
    openInjectionParts(target);
    writeInjectionPart(target, [notRun('settings-broken')]);
    writeInjectionPart(target, [notRun('kill-at-step')]);
    writeInjectionPart(target, [notRun('budget-reached')]);
    await assembleInjectionReport(target);
    const report = JSON.parse(fs.readFileSync(target, 'utf8')) as { population: { notRun: { id: string }[] } };
    const expected = injectionReportOf([notRun('kill-at-step'), notRun('budget-reached'), notRun('settings-broken')]);
    expect(report).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(report.population.notRun.map((entry) => entry.id)).toEqual(['kill-at-step', 'budget-reached', 'settings-broken']);
    expect(fs.existsSync(injectionPartsDirOf(target))).toBe(false);
  });

  it('starts each run with no part of an earlier run', async () => {
    const target = targetIn();
    openInjectionParts(target);
    writeInjectionPart(target, [notRun('budget-reached')]);
    openInjectionParts(target);
    writeInjectionPart(target, [notRun('kill-at-step')]);
    await assembleInjectionReport(target);
    const report = JSON.parse(fs.readFileSync(target, 'utf8')) as { population: { notRun: { id: string }[] } };
    expect(report.population.notRun.map((entry) => entry.id)).toEqual(['kill-at-step']);
  });
});
