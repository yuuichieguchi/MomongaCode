import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { readManifest } from './formal/manifest.ts';

const root = path.resolve(import.meta.dirname, '..');
const specDirectory = path.join(root, 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDirectory, 'CredentialKey.tla'), 'utf8');

const stringsIn = (text: string): string[] => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);

const definedLine = (name: string): string => {
  const line = spec.split('\n').find((text) => text.startsWith(`${name} == `));
  if (line === undefined) throw new Error(`CredentialKey.tla has no definition of ${name}`);
  return line;
};

const definedString = (name: string): string => stringsIn(definedLine(name))[0] as string;

const assumedVariants = (): string[] => {
  const line = spec.split('\n').find((text) => text.startsWith('ASSUME Variant \\in {'));
  if (line === undefined) throw new Error('CredentialKey.tla has no ASSUME Variant \\in {...}');
  return stringsIn(line).sort();
};

const exported = foundation as Record<string, unknown>;

const credentialKeyConfigs = (): string[] =>
  readManifest(path.join(specDirectory, 'manifest.json'))
    .entries.map((entry) => entry.config)
    .filter((config) => config === 'CredentialKey' || config.startsWith('CredentialKey.'));

const variantOf = (config: string): string => {
  const text = fs.readFileSync(path.join(specDirectory, `${config}.cfg`), 'utf8');
  const match = /^\s*Variant\s*=\s*"([^"]+)"/m.exec(text);
  return match?.[1] as string;
};

describe('CredentialKey.tla and the encrypted credential store (N81, P5a)', () => {
  it('lists every configuration file in the manifest and every manifest row as a file', () => {
    const files = fs
      .readdirSync(specDirectory)
      .filter((name) => name.startsWith('CredentialKey.') && name.endsWith('.cfg'))
      .map((name) => name.slice(0, -'.cfg'.length))
      .sort();
    expect(credentialKeyConfigs().sort()).toEqual(files);
  });

  it('uses only declared variants in its configurations, and the decided variant in the checks', () => {
    const declared = assumedVariants();
    for (const config of credentialKeyConfigs()) expect(declared, config).toContain(variantOf(config));
    const checks = readManifest(path.join(specDirectory, 'manifest.json')).entries.filter((entry) => entry.config.startsWith('CredentialKey') && entry.role === 'check');
    expect(checks.map((entry) => variantOf(entry.config))).toEqual(checks.map(() => 'decided'));
  });

  it('names the key, the marker file and the lock as the code does (fails until P5a defines the exports)', () => {
    expect(exported.CREDENTIAL_KEY_PREFIX).toBe(definedString('KeyPrefix'));
    expect(exported.CREDENTIAL_KEY_MARKER_FILE).toBe(definedString('MarkerFile'));
    expect(exported.CREDENTIAL_KEY_LOCK_NAME).toBe(definedString('LockName'));
  });

  it('creates the key in the order of the model (fails until P5a defines the export)', () => {
    expect(exported.CREDENTIAL_KEY_CREATION_STEPS).toEqual(stringsIn(definedLine('CreationSteps')));
  });

  it('names the OS points as the spec does', () => {
    expect(stringsIn(definedLine('OsPoints'))).toEqual(['fast', 'locked', 'creating']);
    expect(exported.CREDENTIAL_KEY_OS_POINTS).toEqual(stringsIn(definedLine('OsPoints')));
  });

  it('touches the OS store only at the modelled points', () => {
    const source = fs.readFileSync(path.join(root, 'packages', 'foundation', 'src', 'encrypted-credential-store.ts'), 'utf8');
    const occurrencesOf = (pattern: RegExp): number => [...source.matchAll(pattern)].length;
    expect(occurrencesOf(/\bstore\.read\(/g)).toBe(1);
    expect(occurrencesOf(/\bstore\.write\(/g)).toBe(1);
    expect(occurrencesOf(/(?<!function )\breadNamedKey\(/g)).toBe(3);
    expect(occurrencesOf(/\breadNamedKey\b/g)).toBe(4);
  });
});
