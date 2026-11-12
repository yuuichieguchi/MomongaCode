import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WINDOWS_KEEPER_BINARY_ASSET, WINDOWS_KEEPER_MANIFEST_ASSET, checkedWindowsKeeper, sha256Hex } from '@momonga/foundation';
import { provideEmbeddedWindowsKeeper } from '../src/keeper/host.ts';
import { createTempDir } from '@momonga/testkit';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const homeOf = (): string => {
  const dir = createTempDir();
  dirs.push(dir);
  return dir;
};

const BINARY = new TextEncoder().encode('MZ keeper bytes');
const SHA = sha256Hex(BINARY);
const MANIFEST = new TextEncoder().encode(JSON.stringify({ target: 'win-x64', binary: { asset: WINDOWS_KEEPER_BINARY_ASSET, sha256: SHA, size: BINARY.length, name: 'momonga-keeper.exe' } }));

const portsOf = (home: string) => ({ home, platform: process.platform, env: {}, interrupt: new AbortController().signal });

describe('the composition root extracts the bundled keeper and provides it to the group port', () => {
  it('provides no embedded keeper outside a single executable and in a single executable that carries no keeper', async () => {
    const provided: string[] = [];
    await provideEmbeddedWindowsKeeper(portsOf(homeOf()), undefined, (file) => void provided.push(file), () => undefined, () => true);
    await provideEmbeddedWindowsKeeper(portsOf(homeOf()), { present: () => false, raw: () => new Uint8Array() }, (file) => void provided.push(file), () => undefined, () => true);
    expect(provided).toEqual([]);
  });

  it('extracts the keeper under the executables area and provides its path with the checksum of the manifest', async () => {
    const provided: Array<[string, string]> = [];
    const assets = { present: (name: string) => name === WINDOWS_KEEPER_MANIFEST_ASSET, raw: (name: string) => (name === WINDOWS_KEEPER_MANIFEST_ASSET ? MANIFEST : BINARY) };
    await provideEmbeddedWindowsKeeper(portsOf(homeOf()), assets, (file, sha256) => void provided.push([file, sha256]), () => undefined, () => true);
    const [file, sha256] = provided[0] as [string, string];
    expect(sha256).toBe(SHA);
    expect(path.basename(file)).toBe('momonga-keeper.exe');
    expect(sha256Hex(fs.readFileSync(file))).toBe(SHA);
  });

  it('provides nothing and leaves the home untouched where commands are not launched through a keeper', async () => {
    const provided: unknown[] = [];
    const blocker = path.join(homeOf(), 'not-a-directory');
    fs.writeFileSync(blocker, '');
    const assets = { present: (name: string) => name === WINDOWS_KEEPER_MANIFEST_ASSET, raw: (name: string) => (name === WINDOWS_KEEPER_MANIFEST_ASSET ? MANIFEST : BINARY) };
    const unreachable = portsOf(path.join(blocker, 'home'));
    await provideEmbeddedWindowsKeeper(unreachable, assets, (file) => void provided.push(file), (executable) => void provided.push(executable), () => false);
    await provideEmbeddedWindowsKeeper(unreachable, undefined, (file) => void provided.push(file), (executable) => void provided.push(executable), () => false);
    expect(provided).toEqual([]);
    expect(fs.statSync(blocker).isFile()).toBe(true);
  });

  it('the provided keeper is checked before every start: a changed byte is refused', () => {
    let bytes = BINARY;
    const executable = checkedWindowsKeeper('C:\\cache\\momonga-keeper.exe', SHA, () => bytes);
    expect(executable()).toBe('C:\\cache\\momonga-keeper.exe');
    bytes = new TextEncoder().encode('MZ other bytes');
    expect(() => executable()).toThrow(/does not match/);
  });
});
