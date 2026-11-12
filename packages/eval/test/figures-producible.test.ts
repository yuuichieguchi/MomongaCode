import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIGURE_DATASET_FORMATS, PRODUCIBLE_FIGURES, parseBenchmark, parseContextDataset, parseDataset, parseYieldDataset } from '@momonga/eval';

const PACKAGES = path.resolve(import.meta.dirname, '..', '..');
const EVAL = path.join(PACKAGES, 'eval');

const PARSERS: Readonly<Record<(typeof FIGURE_DATASET_FORMATS)[number], (text: string, source: string) => unknown>> = {
  benchmark: parseBenchmark,
  context: parseContextDataset,
  golden: parseDataset,
  yield: parseYieldDataset,
};

const NAMED_FIGURES = [
  'Task Completion Rate',
  'Human Intervention Rate',
  'Cost per Successful Task',
  'Time per Successful Task',
  'Completion gate against the oracle',
  'grouped by',
  'lossSignalsPerCompaction',
  'continuationRate',
  'costPerSuccess',
  'uncachedInputPerSuccess',
  'reflection yield',
  'false-allow rate',
];

describe('every figure a report or gate names is produced by one command from bundled data (cli-commands-C31)', () => {
  it('lists every named figure once', () => {
    expect(PRODUCIBLE_FIGURES.map((figure) => figure.figure).sort()).toEqual([...NAMED_FIGURES].sort());
  });

  it.each(PRODUCIBLE_FIGURES)('$figure is read from bundled data that parses', (figure) => {
    const file = path.join(EVAL, figure.dataset);
    expect(fs.existsSync(file), file).toBe(true);
    expect(() => PARSERS[figure.datasetFormat](fs.readFileSync(file, 'utf8'), file)).not.toThrow();
  });

  it.each(PRODUCIBLE_FIGURES)('$figure is printed by the report the command writes', (figure) => {
    expect(fs.readFileSync(path.join(PACKAGES, figure.printedBy), 'utf8')).toContain(figure.figure);
  });
});
