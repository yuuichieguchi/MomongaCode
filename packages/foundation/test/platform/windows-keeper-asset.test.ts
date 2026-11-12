import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFileSystem, sha256Hex } from '@momonga/foundation';
import { testKernelLock } from '@momonga/testkit';
import { BUNDLED_EXECUTABLE_STAGED_INFIX } from '../../src/platform/bundled-executable.ts';
import {
  WINDOWS_KEEPER_BINARY_ASSET,
  WINDOWS_KEEPER_MANIFEST_ASSET,
  WindowsKeeperDistributionError,
  ensureBundledWindowsKeeper,
  parseWindowsKeeperManifest,
} from '../../src/platform/windows-keeper-asset.ts';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';

const BINARY = new TextEncoder().encode('the new keeper');
const SHA256 = sha256Hex(BINARY);
const NAME = 'momonga-keeper.exe';
const MANIFEST = JSON.stringify({ target: 'win32-x64', binary: { asset: WINDOWS_KEEPER_BINARY_ASSET, sha256: SHA256, size: BINARY.length, name: NAME } });

const assetsWith = (manifest: string) => (name: string): Uint8Array => {
  if (name === WINDOWS_KEEPER_MANIFEST_ASSET) return new TextEncoder().encode(manifest);
  if (name === WINDOWS_KEEPER_BINARY_ASSET) return BINARY;
  throw new Error(`no asset ${name}`);
};

const countingRandom = () => {
  let next = 0;
  return { hex: () => (next += 1).toString(16).padStart(16, '0') };
};

const refusal = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: rename refused`), { code });

const setupRunningKeeper = () => {
  const executablesRoot = makeTemporaryDirectory();
  const directory = path.join(executablesRoot, `windows-keeper-${SHA256.slice(0, 16)}`);
  fs.mkdirSync(directory, { recursive: true });
  const final = path.join(directory, NAME);
  fs.writeFileSync(final, 'the old keeper that is running');
  return { executablesRoot, directory, final };
};

describe('the keeper asset is put in place by the one replace rule of a running executable', () => {
  it('moves a running keeper that no longer matches its hash aside as a staged entry and moves the new one in', async () => {
    const { executablesRoot, directory, final } = setupRunningKeeper();
    const rename = async (from: string, to: string): Promise<void> => {
      if (to === final && fs.existsSync(final)) throw refusal('EBUSY');
      await fs.promises.rename(from, to);
    };
    const extracted = await ensureBundledWindowsKeeper({ asset: assetsWith(MANIFEST), executablesRoot, random: countingRandom(), files: { ...nodeFileSystem, rename }, lock: testKernelLock() });
    expect(extracted).toBe(final);
    expect(fs.readFileSync(final, 'utf8')).toBe('the new keeper');
    const asides = fs.readdirSync(directory).filter((name) => name.startsWith(`${NAME}${BUNDLED_EXECUTABLE_STAGED_INFIX}`) && fs.readFileSync(path.join(directory, name), 'utf8') === 'the old keeper that is running');
    expect(asides).toHaveLength(1);
  });

  it('reports a refused move aside with its reason and the remedy', async () => {
    const { executablesRoot, final } = setupRunningKeeper();
    const rename = async (from: string, to: string): Promise<void> => {
      if (from === final || to === final) throw refusal('EACCES');
      await fs.promises.rename(from, to);
    };
    const outcome = ensureBundledWindowsKeeper({ asset: assetsWith(MANIFEST), executablesRoot, random: countingRandom(), files: { ...nodeFileSystem, rename }, lock: testKernelLock() });
    await expect(outcome).rejects.toMatchObject({ code: 'EACCES' });
    await expect(outcome).rejects.toThrow(/stop the daemon, then run the command again/);
    expect(fs.readFileSync(final, 'utf8')).toBe('the old keeper that is running');
  });
});

describe('the keeper manifest is read through the one bounded JSON parser', () => {
  it('reads a valid manifest', () => {
    expect(parseWindowsKeeperManifest(MANIFEST).binary).toEqual({ asset: WINDOWS_KEEPER_BINARY_ASSET, sha256: SHA256, size: BINARY.length, name: NAME });
  });

  it('refuses a manifest that is not valid JSON, naming the file and the way forward', () => {
    expect(() => parseWindowsKeeperManifest('{ not json')).toThrow(WindowsKeeperDistributionError);
    expect(() => parseWindowsKeeperManifest('{ not json')).toThrow(new RegExp(`${WINDOWS_KEEPER_MANIFEST_ASSET}.*reinstall`));
  });

  it('refuses a manifest nested beyond the bound, naming the file and the way forward', () => {
    const deep = `${'['.repeat(10000)}${']'.repeat(10000)}`;
    expect(() => parseWindowsKeeperManifest(deep)).toThrow(WindowsKeeperDistributionError);
    expect(() => parseWindowsKeeperManifest(deep)).toThrow(new RegExp(`${WINDOWS_KEEPER_MANIFEST_ASSET}.*reinstall`));
  });
});
