import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { HISTORY_OUTPUT_HEAD_CHARS, HISTORY_OUTPUT_TAIL_CHARS } from '@momonga/foundation';
import { MINIMUM_PAIRS, bindingRuleIds } from '@momonga/eval';
import type { ContextRule } from '@momonga/eval';

const DATASETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../datasets');

type ShippedCase = {
  id: string;
  scenario: string;
  compaction: 'on' | 'off';
  input: string;
  runs: number;
  rules: ContextRule[];
  memories?: { text: string; paths: string[] }[];
  gold?: { anchor: string; in: string }[];
  graders: { kind: string; name?: string; pattern?: string }[];
  files?: Record<string, string>;
};

const casesOf = (file: string): ShippedCase[] => (JSON.parse(readFileSync(path.join(DATASETS, file), 'utf8')) as { cases: ShippedCase[] }).cases;

const scenarioCases = (cases: readonly ShippedCase[], scenario: string): ShippedCase[] => cases.filter((entry) => entry.scenario === scenario);

const expectPairedScenario = (cases: readonly ShippedCase[], scenario: string): ShippedCase[] => {
  const found = scenarioCases(cases, scenario);
  expect(found.map((entry) => entry.id).sort(), scenario).toEqual([`${scenario}-off`, `${scenario}-on`]);
  for (const entry of found) expect(entry.runs, entry.id).toBeGreaterThanOrEqual(2);
  return found;
};

const mentionsHistoryTools = (entry: ShippedCase): boolean =>
  /HistorySearch/.test(entry.input) || /HistoryRead/.test(entry.input) || entry.graders.some((grader) => grader.name === 'HistoryRead' || grader.name === 'HistorySearch');

const RETRIEVAL = ['history-earlier-run', 'history-replaced-range', 'history-with-topical-noise', 'history-two-needles', 'history-no-answer'];
const GOVERNANCE = ['rule-expired', 'rule-out-of-scope-path', 'rule-conflicting-pair', 'rule-many-unrelated', 'rule-dissimilar-to-task'];
const STALE = ['memory-file-deleted', 'memory-superseded-by-newer'];

describe('the shipped context dataset measures every quality metric', () => {
  const cases = casesOf('context.json');

  it.each(RETRIEVAL)('retrieval scenario %s is an on/off pair of at least 2 runs that uses the history tools', (scenario) => {
    for (const entry of expectPairedScenario(cases, scenario)) expect(mentionsHistoryTools(entry), entry.id).toBe(true);
  });

  it('retrieval cases state gold as planted anchors: one per needle, two for two needles, none when nothing is to be found', () => {
    const on = (scenario: string): ShippedCase | undefined => cases.find((entry) => entry.id === `${scenario}-on`);
    for (const scenario of ['history-earlier-run', 'history-replaced-range', 'history-with-topical-noise']) {
      expect(on(scenario)?.gold, scenario).toHaveLength(1);
    }
    expect(on('history-two-needles')?.gold).toHaveLength(2);
    expect(on('history-no-answer')?.gold).toEqual([]);
    for (const scenario of RETRIEVAL) {
      for (const gold of on(scenario)?.gold ?? []) {
        expect(gold.anchor.length).toBeGreaterThan(0);
        expect(['tool.completed', 'user.message', 'agent.message']).toContain(gold.in);
      }
    }
  });

  it('at least MINIMUM_PAIRS scenarios define gold anchors', () => {
    const withGold = new Set(cases.filter((entry) => (entry.gold ?? []).length > 0).map((entry) => entry.scenario));
    expect(withGold.size).toBeGreaterThanOrEqual(MINIMUM_PAIRS);
  });

  it.each(GOVERNANCE)('governance scenario %s is an on/off pair of at least 2 runs', (scenario) => {
    expectPairedScenario(cases, scenario);
  });

  it('rule-expired holds a rule that is not live, rule-out-of-scope-path one out of scope', () => {
    const rulesOf = (scenario: string): ContextRule[] => cases.find((entry) => entry.id === `${scenario}-on`)?.rules ?? [];
    expect(rulesOf('rule-expired').some((rule) => !rule.live)).toBe(true);
    expect(rulesOf('rule-out-of-scope-path').some((rule) => !rule.inScope)).toBe(true);
  });

  it('rule-conflicting-pair has two live rules on one target, rule-many-unrelated has 20 rules of which 2 bind', () => {
    const rulesOf = (scenario: string): ContextRule[] => cases.find((entry) => entry.id === `${scenario}-on`)?.rules ?? [];
    const binding = new Set(bindingRuleIds(rulesOf('rule-conflicting-pair')));
    const targets = rulesOf('rule-conflicting-pair').filter((rule) => binding.has(rule.id)).map((rule) => rule.target);
    expect(targets.length - new Set(targets).size).toBeGreaterThanOrEqual(1);
    expect(rulesOf('rule-many-unrelated')).toHaveLength(20);
    expect(bindingRuleIds(rulesOf('rule-many-unrelated'))).toHaveLength(2);
  });

  it('at least MINIMUM_PAIRS scenarios define a binding rule', () => {
    const governed = new Set(cases.filter((entry) => bindingRuleIds(entry.rules).length > 0).map((entry) => entry.scenario));
    expect(governed.size).toBeGreaterThanOrEqual(MINIMUM_PAIRS);
  });

  it.each(STALE)('stale-memory scenario %s is an on/off pair of at least 2 runs with a memory bound to a file', (scenario) => {
    for (const entry of expectPairedScenario(cases, scenario)) {
      expect(entry.memories?.length ?? 0, entry.id).toBeGreaterThan(0);
      expect(entry.memories?.every((memory) => memory.paths.length > 0)).toBe(true);
    }
  });
});

describe('the shipped economy dataset can expose omission and the single cut', () => {
  const cases = casesOf('economy.json');
  const scratch = mkdtempSync(path.join(tmpdir(), 'momonga-economy-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it.each(['failing-build-log', 'failing-test-log-nonenglish', 'passing-long-log-needle', 'large-output-small-window', 'large-output-cjk'])(
    'scenario %s is an on/off pair of at least 2 runs',
    (scenario) => {
      expectPairedScenario(cases, scenario);
    },
  );

  it('passing-long-log-needle requires ReadOutput', () => {
    const on = cases.find((entry) => entry.id === 'passing-long-log-needle-on');
    expect(on?.graders.some((grader) => grader.kind === 'toolCalled' && grader.name === 'ReadOutput')).toBe(true);
  });

  it('the test run of test-failures prints more than the head and tail of the old formatter, so it takes the cut', () => {
    const entry = cases.find((candidate) => candidate.id === 'test-failures-on');
    const files = entry?.files ?? {};
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(scratch, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const run = spawnSync(process.execPath, ['test/run.js'], { cwd: scratch, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: scratch } });
    const printed = `${run.stdout}${run.stderr}`;
    expect(printed.length).toBeGreaterThan(HISTORY_OUTPUT_HEAD_CHARS + HISTORY_OUTPUT_TAIL_CHARS);
  });
});
