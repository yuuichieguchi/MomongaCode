import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CONTEXT_DATASET_FORMAT, DatasetError, bindingRuleIds, buildContextReport, noiseTurnsFor, parseContextDataset, parseDataset } from '@momonga/eval';
import type { Transcript } from '@momonga/eval';
import { contextCase, governing, recorded } from './context-fixtures.ts';

const pair = (scenario: string, overrides: Record<string, unknown> = {}) => [
  { ...contextCase(`${scenario}-on`, scenario, 'on'), ...overrides },
  { ...contextCase(`${scenario}-off`, scenario, 'off'), ...overrides },
];

const datasetOf = (cases: unknown[]) => JSON.stringify({ format: CONTEXT_DATASET_FORMAT, name: 'sample', cases });
const parse = (cases: unknown[]) => parseContextDataset(datasetOf(cases), 'sample.json');

const rule = (id: string, supersedes: string[] = [], target = 'pandas') => ({ id, kind: 'constraint', target, text: `rule ${id}`, inScope: true, live: true, supersedes });

describe('parseContextDataset', () => {
  it('has its own format id', () => {
    expect(CONTEXT_DATASET_FORMAT).toBe('momonga-eval-context/1');
  });

  it('accepts a paired dataset with every extension', () => {
    const [on, off] = pair('s', {
      runs: 2,
      rules: [rule('a'), rule('b', ['a'])],
      revisionDepth: 1,
      noise: { level: 6, topics: ['dataframes'] },
      workspace: [{ beforeRun: 1, write: { 'a.ts': 'new' }, remove: ['b.ts'] }],
      gold: [{ seqFrom: 2, seqTo: 5 }],
    });
    const dataset = parse([on, off]);
    expect(dataset.cases.map((entry) => [entry.id, entry.compaction, entry.scenario])).toEqual([['s-on', 'on', 's'], ['s-off', 'off', 's']]);
    expect(dataset.cases[0]?.workspace).toEqual([{ beforeRun: 1, write: { 'a.ts': 'new' }, remove: ['b.ts'] }]);
    expect(dataset.cases[0]?.gold).toEqual([{ seqFrom: 2, seqTo: 5 }]);
  });

  it.each([
    ['an unknown compaction value', [{ ...pair('s')[0], compaction: 'auto' }, pair('s')[1]], /invalid dataset at \/cases\/0\/compaction/],
    ['a negative noise level', pair('s', { noise: { level: -1, topics: ['t'] } }), /invalid dataset at \/cases\/0\/noise\/level/],
    ['noise without topics', pair('s', { noise: { level: 1, topics: [] } }), /invalid dataset at \/cases\/0\/noise\/topics/],
    ['a gold range that runs backwards', pair('s', { gold: [{ seqFrom: 5, seqTo: 2 }] }), /gold range/],
    ['a gold seq below 1', pair('s', { gold: [{ seqFrom: 0, seqTo: 2 }] }), /invalid dataset at \/cases\/0\/gold\/0\/seqFrom/],
    ['duplicate rule ids', pair('s', { rules: [rule('a'), rule('a', [], 'x')] }), /duplicate rule id a/],
    ['a rule superseding an unknown id', pair('s', { rules: [rule('a', ['ghost'])], revisionDepth: 1 }), /unknown rule ghost/],
    ['a rule superseding across targets', pair('s', { rules: [rule('a'), rule('b', ['a'], 'other')], revisionDepth: 1 }), /different target/],
    ['a revision cycle', pair('s', { rules: [rule('a', ['b']), rule('b', ['a'])], revisionDepth: 2 }), /revision cycle/],
    ['a rule superseding itself', pair('s', { rules: [rule('a', ['a'])], revisionDepth: 1 }), /revision cycle/],
    ['a revision depth that disagrees with the chains', pair('s', { rules: [rule('a'), rule('b', ['a'])], revisionDepth: 3 }), /revisionDepth 3.*longest chain 1/],
    ['a workspace step before the first run', pair('s', { runs: 2, workspace: [{ beforeRun: 0, write: { 'a.ts': 'x' } }] }), /invalid dataset at \/cases\/0\/workspace\/0\/beforeRun/],
    ['a workspace step after the last run', pair('s', { runs: 2, workspace: [{ beforeRun: 2, write: { 'a.ts': 'x' } }] }), /workspace step.*beforeRun 2/],
    ['a workspace step that changes nothing', pair('s', { runs: 2, workspace: [{ beforeRun: 1 }] }), /workspace step.*changes nothing/],
    ['a workspace write that escapes', pair('s', { runs: 2, workspace: [{ beforeRun: 1, write: { '../x': 'y' } }] }), /relative paths inside the workspace/],
    ['a workspace remove that escapes', pair('s', { runs: 2, workspace: [{ beforeRun: 1, remove: ['/etc/passwd'] }] }), /relative paths inside the workspace/],
    ['a scenario without its off case', [pair('s')[0]], /scenario s needs exactly one on case and one off case/],
    ['a scenario with two on cases', [pair('s')[0], { ...pair('s')[0], id: 'other' }], /scenario s needs exactly one on case and one off case/],
    ['a pair with different inputs', [pair('s')[0], { ...pair('s')[1], input: 'something else' }], /scenario s.*differ/],
    ['a pair with different rules', [pair('s')[0], { ...pair('s')[1], rules: [rule('a')] }], /scenario s.*differ/],
    ['a pair with different workspaces', [{ ...pair('s')[0], runs: 2 }, { ...pair('s')[1], runs: 3 }], /scenario s.*differ/],
  ])('rejects %s', (_name, cases, message) => {
    expect(() => parse(cases as unknown[])).toThrow(DatasetError);
    expect(() => parse(cases as unknown[])).toThrow(message);
  });

  it('refuses a golden dataset, because its cases are not paired', () => {
    expect(() => parseContextDataset(JSON.stringify({ format: 'momonga-eval/1', name: 'x', cases: [] }), 'g.json')).toThrow(DatasetError);
  });
});

describe('noiseTurnsFor', () => {
  const golden = (level: number) => parse(pair('s', { rules: [rule('a', [], 'polars-engine')], noise: { level, topics: ['dataframes', 'plotting'] } })).cases[0]!;

  it('produces one user and assistant pair per noise level', () => {
    expect(noiseTurnsFor(golden(12), 1)).toHaveLength(12);
    expect(noiseTurnsFor(golden(0), 1)).toEqual([]);
  });

  it('is deterministic under a seed', () => {
    expect(noiseTurnsFor(golden(6), 7)).toEqual(noiseTurnsFor(golden(6), 7));
  });

  it('shares the topic and never holds a token of the rule target', () => {
    for (const turn of noiseTurnsFor(golden(20), 3)) {
      expect(`${turn.user} ${turn.assistant}`).toMatch(/dataframes|plotting/);
      expect(`${turn.user} ${turn.assistant}`.toLowerCase()).not.toMatch(/polars|engine/);
    }
  });
});

describe('the starter dataset', () => {
  const load = async () => parseContextDataset(await fs.readFile(new URL('../datasets/context.json', import.meta.url), 'utf8'), 'context.json');

  it('pairs three coding scenarios', async () => {
    const dataset = await load();
    expect(dataset.cases).toHaveLength(6);
    expect([...new Set(dataset.cases.map((entry) => entry.scenario))]).toEqual(['rename-module', 'revised-test-runner', 'file-changed-between-runs']);
  });

  it('has a depth 2 revision chain whose only binding rule is the last', async () => {
    const dataset = await load();
    const revised = dataset.cases.find((entry) => entry.id === 'revised-test-runner-on')!;
    expect(revised.revisionDepth).toBe(2);
    expect(bindingRuleIds(revised.rules)).toEqual(['runner-3']);
  });

  it('runs on the replay path with no model and proves the machinery', async () => {
    const dataset = await load();
    const transcripts: Transcript[] = dataset.cases.flatMap((entry) =>
      Array.from({ length: entry.runs }, (_unused, runIndex) => recorded(entry.id, runIndex, [governing(...bindingRuleIds(entry.rules))], { totalTokens: 50 })),
    );
    const report = buildContextReport({ dataset, transcripts, model: 'fake' });
    expect(report.model).toBe('fake');
    expect(report.metrics.continuationRate?.trials).toBe(4);
    expect(report.metrics.governanceFidelity).toMatchObject({ successes: 4, trials: 4 });
    expect(report.metrics.governanceConsistency).toMatchObject({ successes: 4, trials: 4 });
    expect(report.metrics.governanceMinimality).toMatchObject({ successes: 4, trials: 4 });
    expect(report.metrics.tokensPerSuccess).toMatchObject({ value: 50, n: 8 });
  });
});

describe('golden datasets', () => {
  it.each(['starter.json', 'auto-mode.json'])('still parses %s unchanged', async (name) => {
    const text = await fs.readFile(new URL(`../datasets/${name}`, import.meta.url), 'utf8');
    expect(parseDataset(text, name).format).toBe('momonga-eval/1');
  });
});
