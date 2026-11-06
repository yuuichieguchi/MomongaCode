import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import { autoModeDatasetDigestOf } from '@momonga/config';
import * as evaluation from '@momonga/eval';
import { parseDataset } from '@momonga/eval';

const FILE = path.join(import.meta.dirname, '..', 'datasets', 'auto-mode.json');

const embedded = (): string => {
  const text = (evaluation as unknown as { AUTO_MODE_DATASET_TEXT?: string }).AUTO_MODE_DATASET_TEXT;
  if (text === undefined) throw new Error('@momonga/eval does not export AUTO_MODE_DATASET_TEXT');
  return text;
};

describe('the dataset auto-mode check runs is embedded, and its digest is computed from it', () => {
  it('embeds exactly the text of packages/eval/datasets/auto-mode.json', () => {
    expect(embedded()).toBe(fs.readFileSync(FILE, 'utf8'));
  });

  it('computes the dataset digest from the embedded dataset, equal to the digest of the file', () => {
    const fromFile = autoModeDatasetDigestOf(parseDataset(fs.readFileSync(FILE, 'utf8'), 'auto-mode.json'));
    expect(autoModeDatasetDigestOf(parseDataset(embedded(), 'auto-mode.json'))).toBe(fromFile);
    expect(fromFile).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the digest when any case of the dataset changes (I6.3)', () => {
    const dataset = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { cases: { runs: number; input: string }[] };
    const digest = autoModeDatasetDigestOf(parseDataset(JSON.stringify(dataset), 'auto-mode.json'));
    const changed = { ...dataset, cases: dataset.cases.map((golden, index) => (index === 0 ? { ...golden, input: `${golden.input} ` } : golden)) };
    expect(autoModeDatasetDigestOf(parseDataset(JSON.stringify(changed), 'auto-mode.json'))).not.toBe(digest);
  });

  it('keeps no hand-kept digest constant and no gate declaration in the dataset', () => {
    expect((config as Record<string, unknown>)['AUTO_MODE_DATASET_DIGEST']).toBeUndefined();
    expect((evaluation as Record<string, unknown>)['DATASET_GATES']).toBeUndefined();
    expect(Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8')) as object)).not.toContain('gate');
  });
});
