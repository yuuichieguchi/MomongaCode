import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { expandContextDataset, parseContextDataset } from '@momonga/eval';
import { CONTRIBUTION_WINDOW_RUNS } from '@momonga/memory';

const TOKEN_CASE_KINDS = ['repeated-reads', 'test-failures', 'json-api', 'large-grep', 'loop-prone', 'deferral'] as const;

const load = async () => parseContextDataset(await fs.readFile(new URL('../datasets/token.json', import.meta.url), 'utf8'), 'token.json');

const kindOf = (scenario: string): string | undefined => TOKEN_CASE_KINDS.find((kind) => scenario === kind || scenario.startsWith(`${kind}-`));

describe('the token dataset', () => {
  it('validates against the context dataset schema and expands', async () => {
    const dataset = await load();
    expect(dataset.name).toBe('token');
    expect(expandContextDataset(dataset, 0).cases.length).toBe(dataset.cases.length);
  });

  it.each(TOKEN_CASE_KINDS)('holds at least one %s scenario', async (kind) => {
    const dataset = await load();
    expect(dataset.cases.some((entry) => kindOf(entry.scenario) === kind)).toBe(true);
  });

  it('names every scenario by one of the token case kinds', async () => {
    const dataset = await load();
    expect(dataset.cases.filter((entry) => kindOf(entry.scenario) === undefined).map((entry) => entry.scenario)).toEqual([]);
  });

  it('runs the deferral window of unmeasured noise runs before every measured deferral run', async () => {
    const dataset = await load();
    const deferral = expandContextDataset(dataset, 0).cases.filter((entry) => kindOf(entry.scenario) === 'deferral');
    expect(deferral.length).toBeGreaterThan(0);
    for (const entry of deferral) expect(entry.noiseTurns.length, entry.id).toBe(CONTRIBUTION_WINDOW_RUNS);
  });
});
