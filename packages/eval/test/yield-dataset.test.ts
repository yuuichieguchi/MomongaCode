import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DatasetError, MINIMUM_PAIRS, YIELD_DATASET_FORMAT, parseYieldDataset } from '@momonga/eval';
import { FAMILY_IDS, anchorOf, family, yieldDatasetOf } from './yield-fixtures.ts';

const SHIPPED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../datasets/yield.json');

const families = (first: Record<string, unknown>): unknown[] => [first, ...FAMILY_IDS.slice(1).map((id) => family(id))];

const withLearn = (extra: Record<string, unknown>): Record<string, unknown> => {
  const base = family('port');
  return { ...base, learn: { ...(base['learn'] as Record<string, unknown>), ...extra } };
};

const withReuse = (extra: Record<string, unknown>): Record<string, unknown> => {
  const base = family('port');
  return { ...base, reuse: { ...(base['reuse'] as Record<string, unknown>), ...extra } };
};

describe('the yield dataset', () => {
  it('reads a dataset of learn, reuse and accept families', () => {
    const dataset = yieldDatasetOf(FAMILY_IDS.map((id) => family(id)));
    expect(dataset.format).toBe(YIELD_DATASET_FORMAT);
    expect(dataset.families.map((entry) => entry.id)).toEqual([...FAMILY_IDS]);
    expect(dataset.families[0]?.accept.anchors).toEqual([anchorOf('port')]);
  });

  it('refuses a family without accept, with the pointer', () => {
    const { accept: _accept, ...bare } = family('port');
    expect(() => yieldDatasetOf(families(bare))).toThrow(DatasetError);
    expect(() => yieldDatasetOf(families(bare))).toThrow(/yield\.json: invalid dataset at \/families\/0: .*accept/);
  });

  it('refuses accept without an anchor, with the pointer', () => {
    expect(() => yieldDatasetOf(families(family('port', { accept: { anchors: [] } })))).toThrow(/invalid dataset at \/families\/0\/accept\/anchors: /);
    expect(() => yieldDatasetOf(families(family('port', { accept: {} })))).toThrow(/invalid dataset at \/families\/0\/accept: .*anchors/);
  });

  it('refuses an anchor that occurs in the reuse input, with the pointer', () => {
    const stated = withReuse({ input: `Report ${anchorOf('port')} again.` });
    expect(() => yieldDatasetOf(families(stated))).toThrow(
      'yield.json: invalid dataset at /families/0/accept/anchors/0: the anchor "fact-of-port" occurs in /families/0/reuse/input, so a memory that holds it would add nothing',
    );
  });

  it('refuses an anchor that occurs in the files, with the pointer', () => {
    const inContent = withLearn({ files: { 'docs/notes.txt': `the value is ${anchorOf('port')}\n` } });
    expect(() => yieldDatasetOf(families(inContent))).toThrow(
      'yield.json: invalid dataset at /families/0/accept/anchors/0: the anchor "fact-of-port" occurs in /families/0/learn/files/docs~1notes.txt, so a memory that holds it would add nothing',
    );
    const inName = withLearn({ files: { [`${anchorOf('port')}.txt`]: 'x\n' } });
    expect(() => yieldDatasetOf(families(inName))).toThrow(/\/families\/0\/accept\/anchors\/0: the anchor "fact-of-port" occurs in \/families\/0\/learn\/files\/fact-of-port\.txt/);
  });

  it('refuses an anchor that a workspace step writes, with the pointer', () => {
    const written = withLearn({ workspace: [{ beforeRun: 1, write: { 'later.txt': anchorOf('port') } }] });
    expect(() => yieldDatasetOf(families(written))).toThrow(/\/families\/0\/accept\/anchors\/0: the anchor "fact-of-port" occurs in \/families\/0\/learn\/workspace\/0\/write\/later\.txt/);
  });

  it('refuses an unknown key, with the pointer', () => {
    expect(() => yieldDatasetOf(families(family('port', { extra: 1 })))).toThrow(/invalid dataset at \/families\/0: /);
    expect(() => yieldDatasetOf(families(withReuse({ runs: 2 })))).toThrow(/invalid dataset at \/families\/0\/reuse: /);
    expect(() => yieldDatasetOf(families(family('port', { accept: { anchors: [anchorOf('port')], default: true } })))).toThrow(/invalid dataset at \/families\/0\/accept: /);
  });

  it('refuses fewer families than a real interval needs, with the pointer', () => {
    expect(MINIMUM_PAIRS).toBeGreaterThan(1);
    const few = FAMILY_IDS.slice(0, MINIMUM_PAIRS - 1).map((id) => family(id));
    expect(() => yieldDatasetOf(few)).toThrow(/yield\.json: invalid dataset at \/families: /);
  });

  it('refuses a workspace step that is not placed between the two sessions, with the pointer', () => {
    const early = withLearn({ workspace: [{ beforeRun: 2, write: { 'later.txt': 'x' } }] });
    expect(() => yieldDatasetOf(families(early))).toThrow(/invalid dataset at \/families\/0\/learn\/workspace\/0\/beforeRun: /);
  });

  it('refuses two families of one id', () => {
    expect(() => yieldDatasetOf([family('port'), ...FAMILY_IDS.map((id) => family(id))])).toThrow(/duplicate/);
  });
});

describe('the shipped yield dataset', () => {
  it('parses, holds at least the minimum of families, and each reuse task needs a fact its files do not state', () => {
    const dataset = parseYieldDataset(fs.readFileSync(SHIPPED, 'utf8'), 'yield.json');
    expect(dataset.families.length).toBeGreaterThanOrEqual(MINIMUM_PAIRS);
    for (const entry of dataset.families) {
      expect(entry.learn.input).toContain(entry.learn.verification);
      expect(entry.reuse.graders.length).toBeGreaterThan(1);
    }
  });
});
