import { describe, expect, it } from 'vitest';
import type { ChildRole } from '../src/launcher.ts';
import { planRoles } from '../src/plan.ts';
import type { AppliedDigests, SettingsDigests } from '../src/plan.ts';

const SECTIONS = ['sandbox', 'models', 'telemetry', 'network'] as const satisfies ReadonlyArray<keyof SettingsDigests>;

const DEPENDS_ON: Readonly<Record<ChildRole, ReadonlyArray<keyof SettingsDigests>>> = {
  runtime: ['sandbox', 'models', 'telemetry', 'network'],
  gateway: ['models', 'telemetry', 'network'],
};

const applied: SettingsDigests = { sandbox: 's0', models: 'm0', telemetry: 't0', network: 'n0' };

const subsets = <T,>(items: readonly T[]): T[][] => items.reduce<T[][]>((all, item) => [...all, ...all.map((subset) => [...subset, item])], [[]]);

const currentWith = (changed: ReadonlyArray<keyof SettingsDigests>): SettingsDigests =>
  Object.fromEntries(SECTIONS.map((section) => [section, changed.includes(section) ? `${applied[section]}-changed` : applied[section]])) as SettingsDigests;

const presences: ReadonlyArray<{ label: string; digests: AppliedDigests }> = [
  { label: 'both running', digests: { runtime: applied, gateway: { models: applied.models, telemetry: applied.telemetry, network: applied.network } } },
  { label: 'runtime only', digests: { runtime: applied } },
  { label: 'gateway only', digests: { gateway: { models: applied.models, telemetry: applied.telemetry, network: applied.network } } },
  { label: 'neither', digests: {} },
];

describe('planRoles over every combination of changed digests', () => {
  for (const presence of presences) {
    for (const changed of subsets(SECTIONS)) {
      it(`${presence.label}, changed [${changed.join(', ')}]`, () => {
        const expected = (['runtime', 'gateway'] as const).filter(
          (role) => presence.digests[role] !== undefined && DEPENDS_ON[role].some((section) => changed.includes(section)),
        );

        expect(planRoles(currentWith(changed), presence.digests)).toEqual(expected);
      });
    }
  }
});
