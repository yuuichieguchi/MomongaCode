import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTO_MODE_DATASET_DIGEST, autoModeDatasetDigestOf } from '@momonga/config';
import { parseDataset } from '@momonga/eval';

describe('the dataset digest the runtime expects', () => {
  it('is the digest of the shipped auto-mode dataset, so editing the dataset invalidates every record until the constant is updated', () => {
    const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'datasets', 'auto-mode.json'), 'utf8');
    expect(autoModeDatasetDigestOf(parseDataset(text, 'auto-mode.json'))).toBe(AUTO_MODE_DATASET_DIGEST);
  });
});
