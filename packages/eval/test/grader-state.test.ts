import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { grade, gradersOfRun, parseContextDataset } from '@momonga/eval';
import type { ContextCase } from '@momonga/eval';
import { answer, read, recorded } from './context-fixtures.ts';

const load = async () => parseContextDataset(await fs.readFile(new URL('../datasets/context.json', import.meta.url), 'utf8'), 'context.json');

const answers: Record<string, { before: string; after: string }> = {
  'file-changed-between-runs': { before: 'LIMIT is 10.', after: 'LIMIT is 20.' },
  'stale-retries': { before: 'RETRIES is 3.', after: 'RETRIES is 5.' },
  'memory-file-deleted': { before: 'MODE is strict.', after: 'legacy.ts no longer exists.' },
  'memory-superseded-by-newer': { before: 'TIMEOUT is 30.', after: 'TIMEOUT is 60.' },
};

const passes = (entry: ContextCase, runIndex: number, text: string): boolean =>
  grade(gradersOfRun(entry, runIndex), recorded(entry.id, runIndex, [...read('rd', 'file.ts', 'content'), answer(text)])).passed;

describe('stale-memory graders follow the state of the run they grade', () => {
  it.each(Object.keys(answers))('%s: the run before the change needs the old value and the run after it the new one', async (scenario) => {
    const dataset = await load();
    const cases = dataset.cases.filter((entry) => entry.scenario === scenario);
    expect(cases).toHaveLength(2);
    const expected = answers[scenario];
    if (expected === undefined) throw new Error(`no answers for ${scenario}`);
    for (const entry of cases) {
      expect(passes(entry, 0, expected.before)).toBe(true);
      expect(passes(entry, 0, expected.after)).toBe(false);
      expect(passes(entry, 1, expected.after)).toBe(true);
      expect(passes(entry, 1, expected.before)).toBe(false);
      expect(passes(entry, 1, `${expected.before} ${expected.after}`)).toBe(false);
    }
  });

  it('applies the graders of the last state step at or before the run', () => {
    const entry = {
      graders: [{ kind: 'finalTextIncludes', text: 'old' }],
      stateGraders: [{ fromRun: 2, graders: [{ kind: 'finalTextIncludes', text: 'new' }] }],
    } as const satisfies Pick<ContextCase, 'graders' | 'stateGraders'>;
    expect(gradersOfRun(entry, 1)).toEqual([{ kind: 'finalTextIncludes', text: 'old' }]);
    expect(gradersOfRun(entry, 2)).toEqual([{ kind: 'finalTextIncludes', text: 'new' }]);
    expect(gradersOfRun(entry, 3)).toEqual([{ kind: 'finalTextIncludes', text: 'new' }]);
  });
});

describe('history cases state only what the harness plays', () => {
  it('no case asks the model to answer questions that follow, because noise turns come before the input and nothing is asked after it', async () => {
    const dataset = await load();
    expect(dataset.cases.filter((entry) => /questions that follow/u.test(entry.input)).map((entry) => entry.id)).toEqual([]);
  });

  it('every case whose input reads files names only files the case plants', async () => {
    const dataset = await load();
    const missing = dataset.cases.flatMap((entry) =>
      [...entry.input.matchAll(/\b((?:ops|logs)\/[\w.]+\.(?:md|log))\b/gu)].map((match) => match[1]).filter((name) => name !== undefined && entry.files?.[name] === undefined).map((name) => `${entry.id}: ${name}`),
    );
    expect(missing).toEqual([]);
  });
});
