import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WINDOWS_KEEPER_BINARY_ASSET, WINDOWS_KEEPER_COMPILER_MISSING_EXIT, WINDOWS_KEEPER_MANIFEST_ASSET, claimPathOf, lockFormOf, sha256Hex, sidecarOf } from '@momonga/foundation';
import type { KeeperPreparation } from '@momonga/foundation';
import { provideEmbeddedWindowsKeeper } from '../src/keeper/host.ts';
import { KEEPER_BUILD_BOUND_MS, nodeSourceKeeperFiles, runKeeperBuildWithin } from '../src/node-ports.ts';
import { sourceBuiltWindowsKeeper } from '../src/keeper/source.ts';
import type { KeeperBuildEnding, SourceKeeperPorts } from '../src/keeper/source.ts';
import { createTempDir, testKernelLock, writeLeftoverEntry } from '@momonga/testkit';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const rootOf = (): string => {
  const dir = createTempDir();
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

const worldOf = (build: (workDir: string) => KeeperBuildEnding): World => {
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
        return Promise.resolve(build(workDir));
      },
      files: nodeSourceKeeperFiles,
      random: { hex: () => 'abcdef0123456789' },
      lock: testKernelLock(),
    },
  };
};

describe('a from-source run builds the keeper on first need and checks it like the bundled one', () => {
  it('builds nothing until a keeper is needed', () => {
    const world = worldOf(() => 0);
    sourceBuiltWindowsKeeper(world.ports);
    expect(world.builds).toEqual([]);
  });

  it('builds once, keeps the keeper under the executables area by its checksum, and removes the work directory', async () => {
    const world = worldOf((workDir) => {
      writesKeeper(workDir);
      return 0;
    });
    const executable = sourceBuiltWindowsKeeper(world.ports);
    const check = await executable();
    const file = check();
    expect(file).toBe(path.join(world.ports.executablesRoot, `windows-keeper-${SHA.slice(0, 16)}`, 'momonga-keeper.exe'));
    expect(sha256Hex(fs.readFileSync(file))).toBe(SHA);
    expect(await executable()).toBe(check);
    expect(check()).toBe(file);
    expect(world.builds).toHaveLength(1);
    expect(fs.existsSync(world.builds[0] as string)).toBe(false);
  });

  it('checks the keeper before every start: a changed byte is refused', async () => {
    const world = worldOf((workDir) => {
      writesKeeper(workDir);
      return 0;
    });
    const check = await sourceBuiltWindowsKeeper(world.ports)();
    const file = check();
    fs.writeFileSync(file, 'MZ other bytes');
    expect(() => check()).toThrow(/does not match/);
  });

  it('refuses a built keeper that does not match its manifest', async () => {
    const world = worldOf((workDir) => {
      writesKeeper(workDir, new TextEncoder().encode('MZ something else'));
      return 0;
    });
    await expect(sourceBuiltWindowsKeeper(world.ports)()).rejects.toThrow(/does not match the checksum in its manifest/);
  });

  it('refuses with one sentence that names zig when the compiler is absent', async () => {
    const world = worldOf(() => WINDOWS_KEEPER_COMPILER_MISSING_EXIT);
    await expect(sourceBuiltWindowsKeeper(world.ports)()).rejects.toThrow(
      'zig was not found on PATH, so the keeper executable that a from-source run on Windows needs could not be built from native/windows-keeper/keeper.c',
    );
  });

  it('names the exit code of a build that failed for another reason', async () => {
    const world = worldOf(() => 1);
    await expect(sourceBuiltWindowsKeeper(world.ports)()).rejects.toThrow('the keeper executable could not be built from native/windows-keeper/keeper.c: the build ended with exit code 1');
  });

  it('names the build script when it is absent', async () => {
    const world = worldOf(() => 0);
    fs.rmSync(world.ports.script);
    await expect(sourceBuiltWindowsKeeper(world.ports)()).rejects.toThrow(`the keeper executable could not be built for this from-source run: ${world.ports.script} is missing`);
    expect(world.builds).toEqual([]);
  });

  it('removes a staged file that a run which died left beside the keeper, on the next source run', async () => {
    const world = worldOf((workDir) => {
      writesKeeper(workDir);
      return 0;
    });
    const directory = path.join(world.ports.executablesRoot, `windows-keeper-${SHA.slice(0, 16)}`);
    fs.mkdirSync(directory, { recursive: true });
    const dead = path.join(directory, 'momonga-keeper.exe.partial-0123456789abcdef');
    writeLeftoverEntry(world.ports.lock, dead, 'MZ half written');
    await sourceBuiltWindowsKeeper(world.ports)();
    expect(fs.existsSync(dead)).toBe(false);
  });

});

describe('outside a single executable the composition root provides the keeper built from source', () => {
  it('provides it lazily: nothing is built at start', () => {
    const provided: KeeperPreparation[] = [];
    provideEmbeddedWindowsKeeper({ env: {}, home: rootOf(), platform: process.platform, interrupt: new AbortController().signal }, undefined, (prepare) => void provided.push(prepare), () => true);
    expect(provided).toHaveLength(1);
  });

  it('provides nothing from source in a single executable that carries no keeper', () => {
    const provided: KeeperPreparation[] = [];
    provideEmbeddedWindowsKeeper(
      { env: {}, home: rootOf(), platform: process.platform, interrupt: new AbortController().signal },
      { present: () => false, raw: () => new Uint8Array() },
      (prepare) => void provided.push(prepare),
      () => true,
    );
    expect(provided).toEqual([]);
  });
});

describe('the work directory of a from-source build is claimed the product way', () => {
  it('holds the sidecar claim of the work directory while the build runs', async () => {
    let claimedDuringBuild: boolean | undefined;
    const world = worldOf((workDir) => {
      claimedDuringBuild = fs.existsSync(sidecarOf(world.ports.lock, workDir));
      writesKeeper(workDir);
      return 0;
    });
    await sourceBuiltWindowsKeeper(world.ports)();
    expect(claimedDuringBuild).toBe(true);
  });

  it('removes a work directory that a killed build left with no holder, on the next source run', async () => {
    const world = worldOf((workDir) => {
      writesKeeper(workDir);
      return 0;
    });
    const dead = path.join(world.ports.executablesRoot, 'windows-keeper-source-0123456789abcdef');
    fs.mkdirSync(path.join(dead, 'windows-keeper'), { recursive: true });
    const outcome = await world.ports.lock.claim(claimPathOf(world.ports.lock, dead, lockFormOf(world.ports.lock, 'directory')));
    if (outcome.kind !== 'claimed') throw new Error('the dead work directory is held by no one in this test');
    outcome.lock.release();
    await sourceBuiltWindowsKeeper(world.ports)();
    expect(fs.existsSync(dead)).toBe(false);
  });
});

describe('the keeper build is waited for within its registered bound', () => {
  it('refuses with one sentence that names the build, its source and the bound when the build does not end in time', async () => {
    const world = worldOf(() => ({ timedOut: true, boundMs: 5 }));
    await expect(sourceBuiltWindowsKeeper(world.ports)()).rejects.toThrow('the build of the keeper executable from native/windows-keeper/keeper.c did not end within 5 ms');
  });

  it('runs the build script as a child without blocking, ends it at the bound, and reports its exit code otherwise', async () => {
    const root = rootOf();
    const endless = path.join(root, 'endless.mjs');
    const failing = path.join(root, 'failing.mjs');
    fs.writeFileSync(endless, 'setInterval(() => undefined, 1000);');
    fs.writeFileSync(failing, 'process.exit(3);');
    const pending = runKeeperBuildWithin(300)(endless, root);
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual({ timedOut: true, boundMs: 300 });
    expect(await runKeeperBuildWithin(KEEPER_BUILD_BOUND_MS)(failing, root)).toBe(3);
  });
});
