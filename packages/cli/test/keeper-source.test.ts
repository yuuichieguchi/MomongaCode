import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WINDOWS_KEEPER_BINARY_ASSET, WINDOWS_KEEPER_COMPILER_MISSING_EXIT, WINDOWS_KEEPER_MANIFEST_ASSET, sha256Hex } from '@momonga/foundation';
import { provideEmbeddedWindowsKeeper } from '../src/keeper/host.ts';
import { nodeSourceKeeperFiles } from '../src/node-ports.ts';
import { sourceBuiltWindowsKeeper } from '../src/keeper/source.ts';
import type { SourceKeeperPorts } from '../src/keeper/source.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const rootOf = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-keeper-source-')));
  dirs.push(dir);
  return dir;
};

const BINARY = new TextEncoder().encode('MZ keeper built from source');
const SHA = sha256Hex(BINARY);

const writesKeeper = (workDir: string, binary: Uint8Array = BINARY): void => {
  const directory = path.join(workDir, 'windows-keeper');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, WINDOWS_KEEPER_BINARY_ASSET), binary);
  fs.writeFileSync(path.join(directory, WINDOWS_KEEPER_MANIFEST_ASSET), JSON.stringify({ target: 'win-x64', binary: { asset: WINDOWS_KEEPER_BINARY_ASSET, sha256: SHA, size: BINARY.length, name: 'momonga-keeper.exe' } }));
};

type World = { ports: SourceKeeperPorts; builds: string[]; root: string };

const worldOf = (build: (workDir: string) => number | null): World => {
  const root = rootOf();
  const script = path.join(root, 'scripts', 'windows-keeper.ts');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '');
  const builds: string[] = [];
  return {
    root,
    builds,
    ports: {
      script,
      executablesRoot: path.join(root, 'executables'),
      build: (given, workDir) => {
        expect(given).toBe(script);
        builds.push(workDir);
        return build(workDir);
      },
      files: nodeSourceKeeperFiles,
      random: { hex: () => 'abcdef0123456789' },
    },
  };
};

describe('a from-source run builds the keeper on first need and checks it like the bundled one', () => {
  it('builds nothing until a keeper is needed', () => {
    const world = worldOf(() => 0);
    sourceBuiltWindowsKeeper(world.ports);
    expect(world.builds).toEqual([]);
  });

  it('builds once, keeps the keeper under the executables area by its checksum, and removes the work directory', () => {
    const world = worldOf((workDir) => {
      writesKeeper(workDir);
      return 0;
    });
    const executable = sourceBuiltWindowsKeeper(world.ports);
    const file = executable();
    expect(file).toBe(path.join(world.ports.executablesRoot, `windows-keeper-${SHA.slice(0, 16)}`, 'momonga-keeper.exe'));
    expect(sha256Hex(fs.readFileSync(file))).toBe(SHA);
    expect(executable()).toBe(file);
    expect(world.builds).toHaveLength(1);
    expect(fs.existsSync(world.builds[0] as string)).toBe(false);
  });

  it('checks the keeper before every start: a changed byte is refused', () => {
    const world = worldOf((workDir) => {
      writesKeeper(workDir);
      return 0;
    });
    const executable = sourceBuiltWindowsKeeper(world.ports);
    const file = executable();
    fs.writeFileSync(file, 'MZ other bytes');
    expect(() => executable()).toThrow(/does not match/);
  });

  it('refuses a built keeper that does not match its manifest', () => {
    const world = worldOf((workDir) => {
      writesKeeper(workDir, new TextEncoder().encode('MZ something else'));
      return 0;
    });
    expect(() => sourceBuiltWindowsKeeper(world.ports)()).toThrow(/does not match the checksum in its manifest/);
  });

  it('refuses with one sentence that names zig when the compiler is absent', () => {
    const world = worldOf(() => WINDOWS_KEEPER_COMPILER_MISSING_EXIT);
    expect(() => sourceBuiltWindowsKeeper(world.ports)()).toThrow(
      'zig was not found on PATH, so the keeper executable that a from-source run on Windows needs could not be built from native/windows-keeper/keeper.c',
    );
  });

  it('names the exit code of a build that failed for another reason', () => {
    const world = worldOf(() => 1);
    expect(() => sourceBuiltWindowsKeeper(world.ports)()).toThrow('the keeper executable could not be built from native/windows-keeper/keeper.c: the build ended with exit code 1');
  });

  it('names the build script when it is absent', () => {
    const world = worldOf(() => 0);
    fs.rmSync(world.ports.script);
    expect(() => sourceBuiltWindowsKeeper(world.ports)()).toThrow(`the keeper executable could not be built for this from-source run: ${world.ports.script} is missing`);
    expect(world.builds).toEqual([]);
  });
});

describe('outside a single executable the composition root provides the keeper built from source', () => {
  it('provides it lazily: nothing is built at start', async () => {
    const home = rootOf();
    const provided: Array<() => string> = [];
    const embedded: string[] = [];
    await provideEmbeddedWindowsKeeper({ env: {}, home, platform: process.platform, interrupt: new AbortController().signal }, undefined, (file) => void embedded.push(file), (executable) => void provided.push(executable), () => true);
    expect(embedded).toEqual([]);
    expect(provided).toHaveLength(1);
  });

  it('provides nothing from source in a single executable that carries no keeper', async () => {
    const provided: Array<() => string> = [];
    await provideEmbeddedWindowsKeeper(
      { env: {}, home: rootOf(), platform: process.platform, interrupt: new AbortController().signal },
      { present: () => false, raw: () => new Uint8Array() },
      () => undefined,
      (executable) => void provided.push(executable),
      () => true,
    );
    expect(provided).toEqual([]);
  });
});
