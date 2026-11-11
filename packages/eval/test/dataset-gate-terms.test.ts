import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MINIMUM_PAIRS, QUALITY_METRICS, expandContextDataset, parseContextDataset, qualityMetricsWithData } from '@momonga/eval';

const load = async (name: string) =>
  expandContextDataset(parseContextDataset(await fs.readFile(new URL(`../datasets/${name}`, import.meta.url), 'utf8'), name), 1);

describe.each([
  ['context.json', 'context'],
  ['economy.json', 'token'],
])('the data set %s of the %s gate', (name) => {
  it.each(QUALITY_METRICS.map(({ name: metric }) => metric))('has at least the minimum number of cases with data for %s', async (metric) => {
    const dataset = await load(name);
    const measuring = dataset.cases.filter((entry) => qualityMetricsWithData(entry).includes(metric));
    expect(measuring.length).toBeGreaterThanOrEqual(MINIMUM_PAIRS);
  });
});

describe('qualityMetricsWithData', () => {
  it('names a metric only when the case carries the data it reads', async () => {
    const dataset = await load('economy.json');
    const plain = dataset.cases.find((entry) => entry.id === 'large-grep-off');
    expect(plain === undefined ? undefined : qualityMetricsWithData(plain)).toEqual([]);
  });
});
