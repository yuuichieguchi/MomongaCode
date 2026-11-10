import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readManifest } from './formal/manifest.ts';

const specDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'ModelRef.tla'), 'utf8');

const DECIDED = 'decided';

const VIOLATED_BY_VARIANT: Readonly<Record<string, string>> = {
  storeDisplay: 'NoRebind',
  storedBareName: 'NoRebind',
  lastWins: 'NoGuess',
  shortFirst: 'NoGuess',
  unpinned: 'RunKeepsPin',
  noCascade: 'WriterKeepsLoadable',
  displayShortOnly: 'DisplayRoundTrip',
  shortEverywhere: 'ShortOnlyWithDefaultTag',
  noNorm: 'OneOwnNamePerModel',
  serveUnchecked: 'ServedIsNamed',
  forgetUsed: 'WriterKeepsLoadable',
  flipNoNorm: 'OneOwnNamePerModel',
  reclaimRepins: 'ResumeKeepsPin',
  roleLate: 'RunKeepsPin',
};

const TEMPORAL_ACTION_PROPERTY_EXIT = 13;
const INVARIANT_EXIT = 12;

const DEF_TAG_OF_CONFIG: Readonly<Record<string, string>> = {
  ModelRef: 'DefTagMixed',
  'ModelRef.slash': 'DefTagNone',
  'ModelRef.slashTag': 'DefTagMixed',
  'ModelRef.rename': 'DefTagAll',
};

const TABLE_CONFIGS = ['ModelRef', 'ModelRef.slashTag'] as const;

const variants = (): string[] => {
  const assumption = /ASSUME Variant \\in \{([^}]*)\}/.exec(spec);
  if (assumption === null) throw new Error('the Variant assumption is not found in ModelRef.tla');
  return [...(assumption[1] as string).matchAll(/"([^"]+)"/g)].map((match) => match[1] as string).sort();
};

const configOf = (name: string): string => fs.readFileSync(path.join(specDir, `${name}.cfg`), 'utf8');

const constantOf = (cfg: string, name: string): string => {
  const match = new RegExp(`^\\s*${name}\\s*(?:=|<-)\\s*(.+?)\\s*$`, 'm').exec(cfg);
  if (match === null) throw new Error(`${name} is not set`);
  return match[1] as string;
};

const entries = () => readManifest(path.join(specDir, 'manifest.json')).entries.filter((entry) => /^ModelRef(\.|$)/.test(entry.config));

describe('ModelRef.tla and its configurations (a model is named by its server and its own name)', () => {
  it('the variants of the model are the design and the wrong rules the design names', () => {
    expect(variants()).toEqual([DECIDED, ...Object.keys(VIOLATED_BY_VARIANT)].sort());
  });

  it('each wrong rule has exactly one evidence configuration, run every time, that violates its property', () => {
    const evidence = entries().filter((entry) => entry.role === 'evidence');
    const found = Object.fromEntries(evidence.map((entry) => [JSON.parse(constantOf(configOf(entry.config), 'Variant')) as string, typeof entry.expect === 'object' ? entry.expect.violates : 'holds']));
    expect(evidence).toHaveLength(Object.keys(VIOLATED_BY_VARIANT).length);
    expect(found).toEqual(VIOLATED_BY_VARIANT);
    for (const entry of evidence) {
      expect(entry.tier, entry.config).toBe('every-run');
      expect(entry.config, entry.config).toBe(`ModelRef.${JSON.parse(constantOf(configOf(entry.config), 'Variant')) as string}`);
      expect(typeof entry.expect === 'object' ? entry.expect.exitCode : 0, entry.config).toBe(entry.config === 'ModelRef.serveUnchecked' ? TEMPORAL_ACTION_PROPERTY_EXIT : INVARIANT_EXIT);
    }
    for (const entry of entries().filter((candidate) => candidate.role === 'check')) {
      expect(entry.expect, entry.config).toBe('holds');
      expect(constantOf(configOf(entry.config), 'Variant'), entry.config).toBe(JSON.stringify(DECIDED));
    }
  });

  it('every configuration of the model is in the manifest, and every manifest entry has its configuration', () => {
    const configs = fs.readdirSync(specDir).filter((file) => /^ModelRef(\.\w+)?\.cfg$/.test(file)).map((file) => file.slice(0, -'.cfg'.length)).sort();
    expect(entries().map((entry) => entry.config).sort()).toEqual(configs);
    expect(entries().find((entry) => entry.config === 'ModelRef')).toMatchObject({ role: 'check', expect: 'holds', tier: 'every-run' });
    expect(entries().find((entry) => entry.config === 'ModelRef.childDeep')).toMatchObject({ role: 'check', expect: 'holds', tier: 'deep' });
  });

  it('each instance has the default tags the design gives it, and the two table instances are the ones whose tables the code is compared with', () => {
    for (const [name, defTag] of Object.entries(DEF_TAG_OF_CONFIG)) expect(constantOf(configOf(name), 'DefTag'), name).toBe(defTag);
    const printing = entries().map((entry) => entry.config).filter((name) => constantOf(configOf(name), 'PrintTable') === 'TRUE').sort();
    expect(printing).toEqual([...TABLE_CONFIGS].sort());
    for (const file of ['ModelRef.table.json', 'ModelRef.slash.table.json']) {
      const table = JSON.parse(fs.readFileSync(path.join(specDir, file), 'utf8')) as { defaultTag: Record<string, boolean>; rows: unknown[] };
      expect(table.defaultTag, file).toEqual({ p1: true, p2: false });
      expect(table.rows, file).toHaveLength(32);
    }
  });
});
