import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATOMIC_WRITE_STEP_ACTIONS, GENERATION_REAPER_STEPS, GENERATION_REAPER_STEP_ACTIONS, LEFTOVER_LOCK_FORMS, atomicWriteSteps, kernelLockNamed, lockFormOf } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { readManifest } from './formal/manifest.ts';

const root = path.resolve(import.meta.dirname, '..');
const specDirectory = path.join(root, 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDirectory, 'LeftoverCleanup.tla'), 'utf8');

const stringsIn = (text: string): string[] => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);

const assumedSet = (constant: string): string[] => {
  const line = spec.split('\n').find((text) => text.startsWith(`ASSUME ${constant} \\in {`));
  if (line === undefined) throw new Error(`LeftoverCleanup.tla has no ASSUME ${constant} \\in {...}`);
  return stringsIn(line).sort();
};

const configValue = (config: string, constant: string): string | undefined => {
  const text = fs.readFileSync(path.join(specDirectory, `${config}.cfg`), 'utf8');
  const match = new RegExp(`^\\s*${constant}\\s*=\\s*"([^"]+)"`, 'm').exec(text);
  return match?.[1];
};

const leftoverConfigs = (): string[] =>
  readManifest(path.join(specDirectory, 'manifest.json'))
    .entries.map((entry) => entry.config)
    .filter((config) => config === 'LeftoverCleanup' || config.startsWith('LeftoverCleanup.'));

const MECHANISM_FORMS: ReadonlyArray<{ mechanism: KernelLockMechanism['name']; kind: 'file' | 'directory'; config: string }> = [
  { mechanism: 'file-lock', kind: 'file', config: 'LeftoverCleanup' },
  { mechanism: 'file-lock', kind: 'directory', config: 'LeftoverCleanup.sidecar' },
  { mechanism: 'sqlite-lock', kind: 'file', config: 'LeftoverCleanup.sidecar' },
  { mechanism: 'sqlite-lock', kind: 'directory', config: 'LeftoverCleanup.sidecar' },
];

const WRITER_ACTION_ORDER = ['CreateLocked', 'Publish', 'Dispose'];

const actionsDefined = (): Set<string> => new Set([...spec.matchAll(/^(\w+)\(w\) ==/gm)].map((match) => match[1] as string));

const withoutRepeats = (names: readonly string[]): string[] => names.filter((name, index) => index === 0 || names[index - 1] !== name);

const C8_OWNERS: readonly string[] = [
  'packages/cli/src/eval/context-effects.ts',
  'packages/cli/src/commands/evaluate.ts',
  'packages/eval/src/bench-grade.ts',
  'packages/sandbox/src/seatbelt.ts',
  'packages/sandbox/src/bubblewrap.ts',
];

const C5_WRITERS: readonly string[] = [
  'packages/gateway/src/probe/record.ts',
  'packages/store/src/blobs.ts',
  'packages/cli/src/update/node-ports.ts',
  'packages/tools/src/builtins/file-writer.ts',
];

const OWN_TEMPORARY_NAMES: readonly RegExp[] = [/process\.pid\}[^`]*\.tmp/, /\.tmp-\$\{/];

describe('T7: LeftoverCleanup.tla and the code name the same lock forms', () => {
  it('the code lists exactly the lock forms the spec assumes', () => {
    expect([...LEFTOVER_LOCK_FORMS].sort()).toEqual(assumedSet('LockForm'));
  });

  for (const { mechanism, kind, config } of MECHANISM_FORMS) {
    it(`${mechanism}, a ${kind} entry, uses the lock form that ${config}.cfg checks`, () => {
      expect(lockFormOf(kernelLockNamed(mechanism), kind)).toBe(configValue(config, 'LockForm'));
    });
  }

  it('every LeftoverCleanup configuration in the manifest names a Variant and a LockForm the spec assumes', () => {
    const variants = assumedSet('Variant');
    const forms = assumedSet('LockForm');
    const configs = leftoverConfigs();
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      expect(variants, config).toContain(configValue(config, 'Variant'));
      expect(forms, config).toContain(configValue(config, 'LockForm'));
    }
  });

  it('the good configurations are the decided variant in each lock form', () => {
    expect(configValue('LeftoverCleanup', 'Variant')).toBe('decided');
    expect(configValue('LeftoverCleanup.sidecar', 'Variant')).toBe('decided');
    expect(new Set(MECHANISM_FORMS.map(({ config }) => configValue(config, 'LockForm')))).toEqual(new Set(LEFTOVER_LOCK_FORMS));
  });
});

describe('T7 and C5: every temporary writer of the actor table goes through the one atomic write (C1)', () => {
  for (const writer of C5_WRITERS) {
    it(`${writer} builds no temporary name of its own`, () => {
      const source = fs.readFileSync(path.join(root, writer), 'utf8');
      for (const pattern of OWN_TEMPORARY_NAMES) expect(source, `${writer} matches ${pattern}`).not.toMatch(pattern);
      expect(source).toMatch(/import \{[^}]*\bwriteFileAtomically(Sync)?\b[^}]*\} from '@momonga\/foundation'/);
    });
  }
});

describe('T7 and S3: the atomic write steps are the writer actions of LeftoverCleanup.tla, in their order', () => {
  it('maps every step to a writer action the spec defines', () => {
    const defined = actionsDefined();
    for (const [step, action] of Object.entries(ATOMIC_WRITE_STEP_ACTIONS)) expect(defined, `${step} -> ${action}`).toContain(action);
  });

  for (const form of ['entry', 'sidecar'] as const) {
    for (const publish of ['replace', 'create'] as const) {
      it(`the ${form} form, ${publish}, runs CreateLocked, Publish and Dispose in that order`, () => {
        const actions = atomicWriteSteps(form, publish).map((step) => ATOMIC_WRITE_STEP_ACTIONS[step]);
        expect(withoutRepeats(actions)).toEqual(WRITER_ACTION_ORDER);
      });
    }
  }
});

describe('T7 and C8: every eval and sandbox scratch owner creates its directory through the one owned-directory helper (S2)', () => {
  for (const owner of C8_OWNERS) {
    it(`${owner} makes no scratch directory of its own`, () => {
      const source = fs.readFileSync(path.join(root, owner), 'utf8');
      expect(source, owner).not.toMatch(/\bmkdtemp(Sync)?\(/);
      expect(source).toMatch(/\bcreateOwnedDirectory(Sync)?\b/);
    });
  }
});

describe('T7 and T-L2-18: the steps of the generation reaper are the reaper actions of LeftoverCleanup.tla, in their order', () => {
  const reaperActionsDefined = (): Set<string> => new Set([...spec.matchAll(/^(\w+)\(g(?:, i)?\) ==/gm)].map((match) => match[1] as string));

  it('runs ClaimDead, ReapMarkers, ClaimInstance, RemoveInstance and RemoveDir in that order', () => {
    expect(GENERATION_REAPER_STEPS.map((step) => GENERATION_REAPER_STEP_ACTIONS[step])).toEqual(['ClaimDead', 'ReapMarkers', 'ClaimInstance', 'RemoveInstance', 'RemoveDir']);
  });

  it('maps every step to an action the spec defines', () => {
    const defined = reaperActionsDefined();
    for (const [step, action] of Object.entries(GENERATION_REAPER_STEP_ACTIONS)) expect(defined, `${step} -> ${action}`).toContain(action);
  });

  it('the spec keeps the variants that show the reaper invariants catch the known bugs', () => {
    expect(assumedSet('Variant')).toEqual(expect.arrayContaining(['reapFirst', 'noClaimDirs', 'listingNumbers', 'unlockedStart', 'instanceNoClaim']));
  });
});
