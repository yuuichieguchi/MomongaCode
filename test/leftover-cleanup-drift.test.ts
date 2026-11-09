import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEFTOVER_LOCK_FORMS, createKernelLockMechanism, lockFormOf } from '@momonga/foundation';
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

const PLATFORM_FORMS: ReadonlyArray<{ platform: NodeJS.Platform; config: string }> = [
  { platform: 'darwin', config: 'LeftoverCleanup' },
  { platform: 'linux', config: 'LeftoverCleanup.sidecar' },
  { platform: 'win32', config: 'LeftoverCleanup.sidecar' },
];

const C5_WRITERS: readonly string[] = [
  'packages/gateway/src/probe/record.ts',
  'packages/store/src/blobs.ts',
  'packages/cli/src/update/node-ports.ts',
  'packages/tools/src/builtins/files.ts',
];

const OWN_TEMPORARY_NAMES: readonly RegExp[] = [/process\.pid\}[^`]*\.tmp/, /\.tmp-\$\{/];

describe('T7: LeftoverCleanup.tla and the code name the same lock forms', () => {
  it('the code lists exactly the lock forms the spec assumes', () => {
    expect([...LEFTOVER_LOCK_FORMS].sort()).toEqual(assumedSet('LockForm'));
  });

  for (const { platform, config } of PLATFORM_FORMS) {
    it(`${platform} uses the lock form that ${config}.cfg checks`, () => {
      expect(lockFormOf(createKernelLockMechanism(platform))).toBe(configValue(config, 'LockForm'));
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
    expect(new Set(PLATFORM_FORMS.map(({ config }) => configValue(config, 'LockForm')))).toEqual(new Set(LEFTOVER_LOCK_FORMS));
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
