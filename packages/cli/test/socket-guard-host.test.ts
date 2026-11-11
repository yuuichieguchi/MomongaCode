import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LINUX_SOCKET_GUARD_BINARY_ASSET, LINUX_SOCKET_GUARD_MANIFEST_ASSET, LinuxSocketGuardDistributionError, WINDOWS_KEEPER_COMPILER_MISSING_EXIT, sha256Hex } from '@momonga/foundation';
import { testLocks } from '@momonga/testkit';
import { hostExtractedLinuxSocketGuard, nodeSourceKeeperFiles } from '../src/node-ports.ts';
import { sourceBuiltLinuxSocketGuard } from '../src/keeper/source.ts';
import type { SourceKeeperPorts } from '../src/keeper/source.ts';
import { socketGuardSourceOf } from '../src/socket-guard/host.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const rootOf = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-socket-guard-')));
  dirs.push(dir);
  return dir;
};

const BINARY = new TextEncoder().encode('\u007fELF socket guard');
const SHA = sha256Hex(BINARY);
const MANIFEST = JSON.stringify({ target: 'linux-x64', binary: { asset: LINUX_SOCKET_GUARD_BINARY_ASSET, sha256: SHA, size: BINARY.length, name: 'momonga-socket-guard' } });

const writesGuard = (workDir: string): void => {
  const directory = path.join(workDir, 'linux-socket-guard');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, LINUX_SOCKET_GUARD_BINARY_ASSET), BINARY);
  fs.writeFileSync(path.join(directory, LINUX_SOCKET_GUARD_MANIFEST_ASSET), MANIFEST);
};

const portsOf = (root: string, build: (workDir: string) => number | null): SourceKeeperPorts => {
  const script = path.join(root, 'scripts', 'linux-socket-guard.ts');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '');
  return { script, executablesRoot: path.join(root, 'executables'), build: (_script, workDir) => build(workDir), files: nodeSourceKeeperFiles, random: { hex: () => 'abcdef0123456789' } };
};

describe('the socket guard of a from-source run on Linux', () => {
  it('is built on first need, kept under the executables area by its checksum as a file its owner can run, and checked before every start', () => {
    const root = rootOf();
    let builds = 0;
    const executable = sourceBuiltLinuxSocketGuard(
      portsOf(root, (workDir) => {
        builds += 1;
        writesGuard(workDir);
        return 0;
      }),
    );
    expect(builds).toBe(0);
    const file = executable();

    expect(file).toBe(path.join(root, 'executables', `linux-socket-guard-${SHA.slice(0, 16)}`, 'momonga-socket-guard'));
    expect(fs.statSync(file).mode & 0o100).toBe(0o100);
    expect(executable()).toBe(file);
    expect(builds).toBe(1);
    fs.writeFileSync(file, 'other bytes');
    expect(() => executable()).toThrow(LinuxSocketGuardDistributionError);
  });

  it('refuses with one sentence that names the compiler when it is absent', () => {
    expect(() => sourceBuiltLinuxSocketGuard(portsOf(rootOf(), () => WINDOWS_KEEPER_COMPILER_MISSING_EXIT))()).toThrow(
      'cc was not found on PATH, so the socket guard executable that a from-source run on Linux needs could not be built from native/linux-socket-guard/guard.c',
    );
  });
});

describe('where the runtime gets its socket guard', () => {
  const embedded = (assets: Record<string, Uint8Array>) => ({ present: (name: string) => name in assets, raw: (name: string) => assets[name] as Uint8Array });
  const neverBuilt = (): (() => string) => {
    throw new Error('no build is expected');
  };
  const extracted = hostExtractedLinuxSocketGuard;

  it('is nowhere on a host that is not Linux, and nowhere in a single executable that carries none', () => {
    expect(socketGuardSourceOf({ platform: 'darwin', embedded: undefined, builtFromSource: neverBuilt, extracted })).toBeUndefined();
    expect(socketGuardSourceOf({ platform: 'win32', embedded: embedded({}), builtFromSource: neverBuilt, extracted })).toBeUndefined();
    expect(socketGuardSourceOf({ platform: 'linux', embedded: embedded({}), builtFromSource: neverBuilt, extracted })).toBeUndefined();
  });

  it('is extracted from the single executable under the executables area', async () => {
    const root = rootOf();
    const source = socketGuardSourceOf({
      platform: 'linux',
      embedded: embedded({ [LINUX_SOCKET_GUARD_MANIFEST_ASSET]: new TextEncoder().encode(MANIFEST), [LINUX_SOCKET_GUARD_BINARY_ASSET]: BINARY }),
      builtFromSource: neverBuilt,
      extracted,
    });
    const file = await source?.({ executables: path.join(root, 'executables') }, testLocks())();

    expect(file).toBe(path.join(root, 'executables', `linux-socket-guard-${SHA.slice(0, 16)}`, 'momonga-socket-guard'));
    expect(fs.statSync(file as string).mode & 0o777).toBe(0o700);
  });

  it('is built from source outside a single executable, and only when a command needs it', async () => {
    const asked: string[] = [];
    const source = socketGuardSourceOf({
      platform: 'linux',
      embedded: undefined,
      builtFromSource: (executablesRoot) => () => {
        asked.push(executablesRoot);
        return '/built/guard';
      },
      extracted,
    });
    const guard = source?.({ executables: '/cache/executables' }, testLocks());

    expect(asked).toEqual([]);
    expect(await guard?.()).toBe('/built/guard');
    expect(asked).toEqual(['/cache/executables']);
  });
});
