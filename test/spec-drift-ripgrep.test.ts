import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { RELEASE_ASSETS, sha256Hex } from '@momonga/foundation';
import type { ClaimOutcome, KernelLockMechanism } from '@momonga/foundation';
import {
  RIPGREP_BINARY_ASSET,
  RIPGREP_MANIFEST_ASSET,
  RIPGREP_NOTICES_ASSET,
  RIPGREP_REPLACEMENT,
  RIPGREP_STAGED_PREFIX,
  RipgrepDistributionError,
  ensureBundledRipgrep,
} from '@momonga/tools';
import type { RipgrepDistributionPorts } from '@momonga/tools';
import { cfgNames } from './formal/cfg-names.ts';
import { RIPGREP_TARGETS } from '../scripts/ripgrep-release.ts';
import { moduleOf, readManifest } from './formal/manifest.ts';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = path.resolve(import.meta.dirname, '..');
const specDir = path.join(root, 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'RipgrepExtract.tla'), 'utf8');


const VERSION = '15.2.0';
const BINARY = new TextEncoder().encode('#!rg-binary-bytes');
const NOTICES = new TextEncoder().encode('COPYING\n');
const AREA = path.join(path.sep, 'cache', 'momonga', 'executables');

const errno = (message: string, code: string): Error => Object.assign(new Error(message), { code });

type Entry = { kind: 'file'; bytes: Uint8Array } | { kind: 'directory' };

const sceneOf = ({ first, inUse, event }: { first: 'absent' | 'good' | 'bad'; inUse: boolean; event: 'none' | 'tamperAfterRename' | 'removeAfterHash' }) => {
  const manifest = {
    version: VERSION,
    target: 'linux-x64',
    binary: { asset: RIPGREP_BINARY_ASSET, sha256: sha256Hex(BINARY), size: BINARY.length, name: 'rg' },
    notices: { asset: RIPGREP_NOTICES_ASSET, sha256: sha256Hex(NOTICES) },
  };
  const directory = path.join(AREA, `ripgrep-${VERSION}-${sha256Hex(BINARY).slice(0, 16)}`);
  const final = path.join(directory, 'rg');
  const entries = new Map<string, Entry>();
  const busy = new Set<string>();
  const held = new Set<string>();
  const mkdirs = (target: string): void => {
    for (let current = target; current !== path.dirname(current); current = path.dirname(current)) if (!entries.has(current)) entries.set(current, { kind: 'directory' });
  };
  if (first !== 'absent') {
    mkdirs(directory);
    entries.set(final, { kind: 'file', bytes: first === 'good' ? BINARY : new TextEncoder().encode('a corrupted copy') });
    if (inUse) busy.add(final);
  }
  let finalReads = 0;
  const files: RipgrepDistributionPorts['files'] = {
    lstat: async (target) => {
      const entry = entries.get(target);
      if (entry === undefined) throw errno('missing', 'ENOENT');
      return { isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'directory', isSymbolicLink: () => false } as fs.Stats;
    },
    mkdirPrivate: async (target) => mkdirs(target),
    open: async (file, flags) => {
      if (flags !== 'wx') throw new Error(`the fake opens only with wx, not ${flags}`);
      if (entries.has(file)) throw errno('exists', 'EEXIST');
      entries.set(file, { kind: 'file', bytes: new Uint8Array() });
      return {
        writeFile: async (content) => {
          entries.set(file, { kind: 'file', bytes: typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content) });
        },
        sync: async () => undefined,
        close: async () => undefined,
      };
    },
    readFile: async (file) => {
      const entry = entries.get(file);
      if (entry?.kind !== 'file') throw errno('missing', 'ENOENT');
      if (file === final) {
        finalReads += 1;
        if (event === 'removeAfterHash' && finalReads === 1) entries.delete(final);
      }
      return entry.bytes;
    },
    rename: async (from, to) => {
      if (busy.has(to)) throw errno('busy', 'EBUSY');
      const entry = entries.get(from);
      if (entry === undefined) throw errno('missing', 'ENOENT');
      entries.delete(from);
      entries.set(to, entry);
      if (to === final && event === 'tamperAfterRename') entries.set(final, { kind: 'file', bytes: new TextEncoder().encode('tampered') });
    },
    rm: async (file) => {
      entries.delete(file);
    },
    readdir: async (target) => [...entries.keys()].filter((key) => path.dirname(key) === target).map((key) => path.basename(key)),
  };
  const claimSync = (lockPath: string): ClaimOutcome => {
    if (held.has(lockPath)) return { kind: 'held' };
    held.add(lockPath);
    const release = (): void => {
      held.delete(lockPath);
    };
    return { kind: 'claimed', lock: { descriptor: undefined, writeHolder: () => undefined, release, dispose: release } };
  };
  const lock: KernelLockMechanism = {
    name: 'file-lock',
    claim: async (lockPath) => claimSync(lockPath),
    claimSync,
    isHeld: async (lockPath) => held.has(lockPath),
    readHolder: async () => undefined,
    readHolderSync: () => undefined,
    claimInheritable: undefined,
    adoptInherited: undefined,
  };
  let counter = 0;
  const ports = (assets: Record<string, Uint8Array> = {}, ownerId = 'self'): RipgrepDistributionPorts => {
    const table: Record<string, Uint8Array> = {
      [RIPGREP_MANIFEST_ASSET]: new TextEncoder().encode(JSON.stringify(manifest)),
      [RIPGREP_BINARY_ASSET]: brotliCompressSync(BINARY),
      [RIPGREP_NOTICES_ASSET]: NOTICES,
      ...assets,
    };
    return {
      asset: (name) => {
        const bytes = table[name];
        if (bytes === undefined) throw new Error(`no embedded asset ${name}`);
        return bytes;
      },
      decompress: async (compressed) => new Uint8Array(brotliDecompressSync(compressed)),
      executablesRoot: AREA,
      random: () => {
        counter += 1;
        return counter / 1000;
      },
      ownerId,
      lock,
      files,
    };
  };
  return { entries, busy, final, ports };
};

const configText = (name: string): string => fs.readFileSync(path.join(specDir, `${name}.cfg`), 'utf8');

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'test' || entry.name === 'dist' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe('RipgrepExtract.tla and the extraction code', () => {
  it('runs the extraction on the cases of the model: every first state of rg, a bad or good embedded blob, rg in use, and a tamper or removal between the steps; never spawns a bad copy, names the cause of each failure, fails without an event only on a bad blob, and always ends', async () => {
    const check = cfgNames(specDir, 'RipgrepExtract');
    expect(check.invariants).toEqual(expect.arrayContaining(['NoBadSpawn', 'SpuriousFree', 'FailureNamesCause']));
    expect(check.properties).toContain('Terminates');
    const failures: string[] = [];
    for (const first of ['absent', 'good', 'bad'] as const) {
      for (const blobBad of [false, true]) {
        for (const event of ['none', 'tamperAfterRename', 'removeAfterHash'] as const) {
          for (const inUse of first === 'absent' ? [false] : [false, true]) {
            const name = `${first} blobBad=${blobBad} ${event} inUse=${inUse}`;
            const scene = sceneOf({ first, inUse, event });
            const outcome = await ensureBundledRipgrep(scene.ports(blobBad ? { [RIPGREP_BINARY_ASSET]: brotliCompressSync(new TextEncoder().encode('a bad blob')) } : {})).then(
              (resolved) => ({ kind: 'spawn' as const, entry: scene.entries.get(resolved.path) }),
              (error: unknown) => ({ kind: 'failed' as const, error }),
            );
            if (outcome.kind === 'spawn') {
              if (outcome.entry?.kind === 'file' && sha256Hex(outcome.entry.bytes) !== sha256Hex(BINARY)) failures.push(`${name}: NoBadSpawn, spawned a copy that is not the embedded ripgrep`);
              continue;
            }
            const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
            const cause = !(outcome.error instanceof RipgrepDistributionError) ? 'none' : /embedded ripgrep .* does not match the checksum/.test(message) ? 'blob' : /changed after it was extracted/.test(message) ? 'tamper' : 'none';
            if (cause === 'none') failures.push(`${name}: FailureNamesCause, ${message}`);
            if (event === 'none' && cause !== 'blob') failures.push(`${name}: SpuriousFree, failed with ${cause} and no event`);
            if (cause === 'blob' && !blobBad) failures.push(`${name}: a good blob was refused`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('NoLiveStagedLost: a resolution that starts while another spawns its own staged file (rg in use) leaves that staged file, and sweeps it once its holder released it', async () => {
    expect(cfgNames(specDir, 'RipgrepExtract').invariants).toContain('NoLiveStagedLost');
    const scene = sceneOf({ first: 'bad', inUse: true, event: 'none' });
    const holder = await ensureBundledRipgrep(scene.ports({}, 'a'));
    expect(holder.path).not.toBe(scene.final);
    const other = await ensureBundledRipgrep(scene.ports({}, 'b'));
    expect(scene.entries.has(holder.path)).toBe(true);
    await other.release();
    await holder.release();
    scene.busy.clear();
    await (await ensureBundledRipgrep(scene.ports({}, 'c'))).release();
    expect([...scene.entries.keys()].filter((key) => path.basename(key).startsWith(RIPGREP_STAGED_PREFIX))).toEqual([]);
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
