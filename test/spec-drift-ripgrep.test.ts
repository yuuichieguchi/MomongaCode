import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RELEASE_ASSETS } from '@momonga/foundation';
import {
  RIPGREP_BINARY_ASSET,
  RIPGREP_MANIFEST_ASSET,
  RIPGREP_NOTICES_ASSET,
  RIPGREP_REPLACEMENT,
  RIPGREP_RESOLUTION_STEPS,
  RIPGREP_STAGED_PREFIX,
} from '@momonga/tools';
import { RIPGREP_TARGETS } from '../scripts/ripgrep-release.ts';
import { moduleOf, readManifest } from './formal/manifest.ts';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = path.resolve(import.meta.dirname, '..');
const specDir = path.join(root, 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'RipgrepExtract.tla'), 'utf8');

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined in RipgrepExtract.tla`);
  const end = spec.indexOf('\n\n', start);
  return spec.slice(start, end === -1 ? undefined : end);
};

const stringsIn = (text: string): string[] => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);

const configText = (name: string): string => fs.readFileSync(path.join(specDir, `${name}.cfg`), 'utf8');

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'test' || entry.name === 'dist' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe('RipgrepExtract.tla and the extraction code', () => {
  it('models every resolution step of the code, and the code has no step the model lacks', () => {
    const modelled = stringsIn(definitionOf('Live')).filter((step) => step !== 'winner');
    expect([...RIPGREP_RESOLUTION_STEPS].sort()).toEqual([...modelled].sort());
  });

  it('models the replacement the code uses: a staged file renamed over rg, never a directory rename', () => {
    expect(RIPGREP_REPLACEMENT).toBe('replaceFile');
    const manifest = readManifest(path.join(specDir, 'manifest.json'));
    const checks = manifest.entries.filter((entry) => moduleOf(entry.config) === 'RipgrepExtract' && entry.role === 'check');
    expect(checks.length).toBeGreaterThan(0);
    for (const entry of checks) expect(configText(entry.config)).toMatch(new RegExp(`Mode\\s*=\\s*"${RIPGREP_REPLACEMENT}"`));
  });

  it('keeps the directory rename only as evidence that it cannot repair a bad copy', () => {
    const manifest = readManifest(path.join(specDir, 'manifest.json'));
    const entry = manifest.entries.find((candidate) => candidate.config === 'RipgrepExtract.renameDir');
    expect(entry?.role).toBe('evidence');
    expect(entry?.expect).toMatchObject({ violates: 'SpuriousFree' });
    expect(configText('RipgrepExtract.renameDir')).toMatch(/Mode\s*=\s*"renameDir"/);
  });

  it('has the evidence configuration that removes the sha256 check and must violate integrity', () => {
    const manifest = readManifest(path.join(specDir, 'manifest.json'));
    const entry = manifest.entries.find((candidate) => candidate.config === 'RipgrepExtract.noVerify');
    expect(entry?.role).toBe('evidence');
    expect(entry?.expect).toMatchObject({ violates: 'NoBadSpawn' });
    expect(configText('RipgrepExtract.noVerify')).toMatch(/VerifyOn\s*=\s*FALSE/);
  });

  it('checks the integrity, repair, typed-failure and sweep invariants and termination in every check configuration', () => {
    const manifest = readManifest(path.join(specDir, 'manifest.json'));
    for (const entry of manifest.entries.filter((candidate) => moduleOf(candidate.config) === 'RipgrepExtract' && candidate.role === 'check')) {
      const text = configText(entry.config);
      for (const name of ['NoBadSpawn', 'SpuriousFree', 'FailureNamesCause', 'NoLiveStagedLost', 'Terminates']) expect(text, `${entry.config} ${name}`).toContain(name);
    }
  });

  it('names the staged files with the prefix the sweep in the code looks for', () => {
    expect(RIPGREP_STAGED_PREFIX).toBe('rg.partial-');
  });
});

describe('one source for the asset names and the target set', () => {
  it('covers exactly the release assets (I6)', () => {
    expect(Object.keys(RIPGREP_TARGETS).sort()).toEqual(Object.keys(RELEASE_ASSETS).sort());
  });

  it('writes each asset name once, in the distribution module, and imports it everywhere else', () => {
    const literals = [RIPGREP_MANIFEST_ASSET, RIPGREP_BINARY_ASSET, RIPGREP_NOTICES_ASSET];
    const owner = path.join(root, 'packages', 'tools', 'src', 'ripgrep-distribution.ts');
    const offenders: string[] = [];
    for (const directory of [path.join(root, 'packages'), path.join(root, 'scripts')]) {
      for (const file of sourceFiles(directory)) {
        if (file === owner) continue;
        const text = fs.readFileSync(file, 'utf8');
        for (const literal of literals) if (text.includes(`'${literal}'`) || text.includes(`"${literal}"`)) offenders.push(`${path.relative(root, file)}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('merges the ripgrep assets into the SEA build next to the Z3 assets', () => {
    const sea = fs.readFileSync(path.join(root, 'scripts', 'sea.ts'), 'utf8');
    expect(sea).toContain('buildRipgrepAssets');
  });

  it('has no ripgrep embedded for a target outside the release assets', () => {
    for (const target of Object.keys(RIPGREP_TARGETS)) expect(Object.hasOwn(RELEASE_ASSETS, target)).toBe(true);
  });
});
