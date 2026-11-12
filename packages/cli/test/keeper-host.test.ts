import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WINDOWS_KEEPER_BINARY_ASSET, WINDOWS_KEEPER_MANIFEST_ASSET, checkedWindowsKeeper, sha256Hex } from '@momonga/foundation';
import type { KeeperPreparation } from '@momonga/foundation';
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

describe('the composition root provides the bundled keeper to the group port, to be extracted at the first launch', () => {
  it('provides no embedded keeper in a single executable that carries no keeper', () => {
    const provided: KeeperPreparation[] = [];
    provideEmbeddedWindowsKeeper(portsOf(homeOf()), { present: () => false, raw: () => new Uint8Array() }, (prepare) => void provided.push(prepare), () => true);
    expect(provided).toEqual([]);
  });

  it('extracts nothing when it provides the keeper, and the preparation extracts it under the executables area and checks it by the checksum of the manifest', async () => {
    const provided: KeeperPreparation[] = [];
    const home = homeOf();
    const assets = { present: (name: string) => name === WINDOWS_KEEPER_MANIFEST_ASSET, raw: (name: string) => (name === WINDOWS_KEEPER_MANIFEST_ASSET ? MANIFEST : BINARY) };
    provideEmbeddedWindowsKeeper(portsOf(home), assets, (prepare) => void provided.push(prepare), () => true);
    expect(fs.readdirSync(home)).toEqual([]);
    const executable = await (provided[0] as KeeperPreparation)();
    const file = executable();
    expect(path.basename(file)).toBe('momonga-keeper.exe');
    expect(sha256Hex(fs.readFileSync(file))).toBe(SHA);
    fs.writeFileSync(file, 'MZ other bytes');
    expect(() => executable()).toThrow(/does not match/);
  });

  it('provides nothing and leaves the home untouched where commands are not launched through a keeper', () => {
    const provided: unknown[] = [];
    const blocker = path.join(homeOf(), 'not-a-directory');
    fs.writeFileSync(blocker, '');
    const assets = { present: (name: string) => name === WINDOWS_KEEPER_MANIFEST_ASSET, raw: (name: string) => (name === WINDOWS_KEEPER_MANIFEST_ASSET ? MANIFEST : BINARY) };
    const unreachable = portsOf(path.join(blocker, 'home'));
    provideEmbeddedWindowsKeeper(unreachable, assets, (prepare) => void provided.push(prepare), () => false);
    provideEmbeddedWindowsKeeper(unreachable, undefined, (prepare) => void provided.push(prepare), () => false);
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
