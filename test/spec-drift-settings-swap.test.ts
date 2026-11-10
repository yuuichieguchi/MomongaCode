import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import * as foundationModule from '@momonga/foundation';
import { readManifest } from './formal/manifest.ts';

const specDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'SettingsSwap.tla'), 'utf8');

const setOf = (name: string): string[] => {
  const line = new RegExp(`^${name} ==\\s*\\{(.*)\\}\\s*$`, 'm').exec(spec);
  if (line === null) throw new Error(`${name} is not defined as a set on one line in SettingsSwap.tla`);
  return [...(line[1] as string).matchAll(/"([^"]+)"/g)].map((match) => match[1] as string).sort();
};

const variants = (): string[] => {
  const line = /^ASSUME Variant \\in \{(.*)\}\s*$/m.exec(spec);
  if (line === null) throw new Error('the Variant assumption is not on one line in SettingsSwap.tla');
  return [...(line[1] as string).matchAll(/"([^"]+)"/g)].map((match) => match[1] as string).sort();
};

const configOf = (name: string): string => fs.readFileSync(path.join(specDir, `${name}.cfg`), 'utf8');
const constantOf = (cfg: string, name: string): string => {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm').exec(cfg);
  if (match === null) throw new Error(`${name} is not set`);
  return match[1] as string;
};
const invariantsOf = (cfg: string): string[] => {
  const block = /INVARIANTS\s+([\s\S]*)$/.exec(cfg);
  return block === null ? [] : (block[1] as string).split(/\s+/).filter((word) => word.length > 0);
};

const DESIGN_PROPERTIES = ['PinStable', 'FreshStart', 'LastValidWins', 'NoRollbackAfterApply', 'AbortIsolated', 'NoCut', 'InvalidKeepsRunning', 'NoRetireInUse', 'NoSweepWhileHeld', 'RetireOnce', 'CarryOverByIdentity', 'SingleDerivation'];

type DerivedObjectDeclaration = { readonly id: string; readonly inputs: readonly string[] };

const codeDerivedObjects = (): readonly DerivedObjectDeclaration[] => {
  const declared = (config as Record<string, unknown>)['DERIVED_OBJECTS'];
  if (!Array.isArray(declared)) throw new Error('@momonga/config does not export DERIVED_OBJECTS (increment S0, packages/config/src/derived.ts)');
  return declared as DerivedObjectDeclaration[];
};

describe('the code follows SettingsSwap.tla (settings applied in place)', () => {
  it('the derived objects of the code are the derived objects of the model, with the same inputs', () => {
    const code = codeDerivedObjects();
    expect(code.map((object) => object.id).sort()).toEqual(setOf('DerivedObjects'));
    for (const object of code) expect([...object.inputs].sort(), object.id).toEqual(setOf(`Inputs${object.id}`));
  });

  it('the holding configurations check every property of the design', () => {
    for (const name of ['SettingsSwap', 'SettingsSwap.underivable', 'SettingsSwap.removal', 'SettingsSwap.reorderHolds']) {
      const invariants = invariantsOf(configOf(name));
      for (const property of DESIGN_PROPERTIES) expect(invariants, `${name} ${property}`).toContain(property);
      expect(constantOf(configOf(name), 'Variant'), name).toBe('"decided"');
    }
  });

  it('every variant of the model other than the design has an evidence configuration that violates a property of the design', () => {
    const manifest = readManifest(path.join(specDir, 'manifest.json'));
    const evidence = manifest.entries.filter((entry) => entry.config.startsWith('SettingsSwap.') && entry.role === 'evidence');
    const used = evidence.map((entry) => JSON.parse(constantOf(configOf(entry.config), 'Variant')) as string);
    expect([...new Set(used)].sort()).toEqual(variants().filter((variant) => variant !== 'decided'));
    for (const entry of evidence) {
      expect(typeof entry.expect === 'object' ? entry.expect.violates : '', entry.config).toSatisfy((property: string) => DESIGN_PROPERTIES.includes(property));
      expect(entry.tier, entry.config).toBe('every-run');
    }
  });

  it('every configuration of the model is in the manifest', () => {
    const configs = fs.readdirSync(specDir).filter((file) => /^SettingsSwap(\.\w+)?\.cfg$/.test(file)).map((file) => file.slice(0, -'.cfg'.length)).sort();
    const entries = readManifest(path.join(specDir, 'manifest.json')).entries.filter((entry) => entry.config.startsWith('SettingsSwap'));
    expect(entries.map((entry) => entry.config).sort()).toEqual(configs);
    expect(entries.find((entry) => entry.config === 'SettingsSwap')).toMatchObject({ role: 'check', expect: 'holds', tier: 'every-run' });
  });

  it('the applied record of the code is the observer of the model: holding with an observer, and alone without one', () => {
    const foundation = foundationModule as Record<string, unknown>;
    expect(foundation['SETTINGS_APPLIED_ENV'], 'foundation exports SETTINGS_APPLIED_ENV (increment S7)').toBe('MOMONGA_SETTINGS_APPLIED');
    expect(foundation['SETTINGS_APPLIED_FILE'], 'foundation exports SETTINGS_APPLIED_FILE (increment S7)').toBe('settings-applied.json');
    const layout = foundationModule.generationLayout('/home/u', 3, 'darwin') as unknown as Record<string, unknown>;
    expect(layout['settingsApplied']).toBe('/home/u/.momonga/run/g3/settings-applied.json');
    expect(constantOf(configOf('SettingsSwap'), 'Observer')).toBe('TRUE');
    expect(constantOf(configOf('SettingsSwap.alone'), 'Observer')).toBe('FALSE');
    expect(invariantsOf(configOf('SettingsSwap.alone'))).toContain('LastValidWins');
  });

  it('the reorder pair differs in the variant only: the same swapped version, the evidence carries by position and violates CarryOverByIdentity, the check carries by identity and holds', () => {
    const holds = configOf('SettingsSwap.reorderHolds');
    const violates = configOf('SettingsSwap.reorder');
    expect(constantOf(holds, 'Variant')).toBe('"decided"');
    expect(constantOf(violates, 'Variant')).toBe('"carryByPosition"');
    expect(constantOf(holds, 'Swapped')).not.toBe('{}');
    expect(constantOf(violates, 'Swapped')).toBe(constantOf(holds, 'Swapped'));
    const manifest = readManifest(path.join(specDir, 'manifest.json')).entries;
    expect(manifest.find((entry) => entry.config === 'SettingsSwap.reorder')).toMatchObject({ role: 'evidence', expect: { violates: 'CarryOverByIdentity', exitCode: 12 }, tier: 'every-run' });
    expect(manifest.find((entry) => entry.config === 'SettingsSwap.reorderHolds')).toMatchObject({ role: 'check', expect: 'holds', tier: 'every-run' });
    for (const entry of manifest.filter((candidate) => candidate.config.startsWith('SettingsSwap') && candidate.config !== 'SettingsSwap.reorder' && candidate.config !== 'SettingsSwap.reorderHolds')) {
      expect(constantOf(configOf(entry.config), 'Swapped'), entry.config).toBe('{}');
    }
  });
});
