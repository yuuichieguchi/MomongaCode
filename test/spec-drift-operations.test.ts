import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATION_CRASH_POINTS, OPERATION_GUARDS, OPERATION_RECONCILE_OUTCOMES, OPERATION_SPECS } from '@momonga/tools';
import { cfgNames } from './formal/cfg-names.ts';
import { moduleOf, readManifest } from './formal/manifest.ts';

const tlaDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');
const spec = fs.readFileSync(path.join(tlaDir, 'ObservedEffect.tla'), 'utf8');

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined in ObservedEffect.tla`);
  const rest = spec.slice(start);
  const end = rest.search(/\n(?=\S)/);
  return end === -1 ? rest : rest.slice(0, end);
};

const setOf = (name: string): string[] => [...definitionOf(name).matchAll(/"([^"]+)"/g)].map((match) => match[1] as string).sort();

const rows = readManifest(path.join(tlaDir, 'manifest.json')).entries.filter((entry) => moduleOf(entry.config) === 'ObservedEffect');

describe('ObservedEffect.tla against the operation code, in both directions', () => {
  it('names exactly the guards of OPERATION_GUARDS', () => {
    expect(setOf('Guards')).toEqual([...OPERATION_GUARDS].sort());
  });

  it('names exactly the reconcile outcomes of OPERATION_RECONCILE_OUTCOMES', () => {
    expect(setOf('ReconcileOutcomes')).toEqual([...OPERATION_RECONCILE_OUTCOMES].sort());
  });

  it('names exactly the crash points of OPERATION_CRASH_POINTS', () => {
    expect(setOf('CrashPoints')).toEqual([...OPERATION_CRASH_POINTS].sort());
  });

  it('checks every guard an operation of the catalogue declares, and declares no guard the catalogue does not use', () => {
    const declared = [...new Set(OPERATION_SPECS.flatMap((operation) => (operation.guard === undefined ? [] : [operation.guard])))].sort();
    const checked = [...new Set(rows.filter((entry) => entry.role === 'check').map((entry) => JSON.parse(cfgNames(tlaDir, entry.config).constants['Guard'] as string) as string))].sort();
    expect(checked).toEqual(declared);
  });

  it('lists one evidence row per broken rule, each violating the property it names', () => {
    const evidence = rows.filter((entry) => entry.role === 'evidence').map((entry) => [entry.config, entry.expect]);
    expect(evidence.sort()).toEqual(
      [
        ['ObservedEffect.blindRedo', { violates: 'NoBlindRedo', exitCode: 12 }],
        ['ObservedEffect.guardIgnored', { violates: 'AtMostOneOpenPR', exitCode: 12 }],
        ['ObservedEffect.noAuthorisedMark', { violates: 'NoNeedlessUnknown', exitCode: 12 }],
        ['ObservedEffect.noneRedo', { violates: 'AtMostOneLanded', exitCode: 12 }],
        ['ObservedEffect.noneRedoGuard', { violates: 'GuardedRedo', exitCode: 12 }],
        ['ObservedEffect.unknownRedo', { violates: 'UnknownIsStable', exitCode: 12 }],
      ].sort(),
    );
  });
});
