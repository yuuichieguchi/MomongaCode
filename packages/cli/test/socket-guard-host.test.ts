import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LINUX_SOCKET_GUARD_BINARY_ASSET, LINUX_SOCKET_GUARD_MANIFEST_ASSET, LinuxSocketGuardDistributionError, WINDOWS_KEEPER_COMPILER_MISSING_EXIT, sha256Hex } from '@momonga/foundation';
import { testKernelLock, testLocks } from '@momonga/testkit';
import { hostExtractedLinuxSocketGuard, nodeSourceKeeperFiles } from '../src/node-ports.ts';
import { prebuiltLinuxSocketGuard } from '../src/keeper/source.ts';
import type { PrebuiltPorts } from '../src/keeper/source.ts';
import { socketGuardSourceOf } from '../src/socket-guard/host.ts';
import { createTempDir } from '@momonga/testkit';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const rootOf = (): string => {
  const dir = createTempDir();
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

const BUILDER = '/repo/scripts/linux-socket-guard.ts';

const portsOf = (root: string): PrebuiltPorts => ({
  builtDirectory: path.join(root, 'dist', 'linux-socket-guard'),
  builder: BUILDER,
  executablesRoot: path.join(root, 'executables'),
  files: nodeSourceKeeperFiles,
  random: { hex: () => 'abcdef0123456789' },
  lock: testKernelLock(),
});

describe('the socket guard of a from-source run on Linux is the one the packaging step built', () => {
  it('is kept under the executables area by its checksum as a file its owner can run, and checked before every start', async () => {
    const root = rootOf();
    writesGuard(path.join(root, 'dist', 'linux-socket-guard'));
    const check = await prebuiltLinuxSocketGuard(portsOf(root))();
    const file = check();

    expect(file).toBe(path.join(root, 'executables', `linux-socket-guard-${SHA.slice(0, 16)}`, 'momonga-socket-guard'));
    expect(fs.statSync(file).mode & 0o100).toBe(0o100);
    expect(check()).toBe(file);
    fs.writeFileSync(file, 'other bytes');
    expect(() => check()).toThrow(LinuxSocketGuardDistributionError);
  });

  it('refuses a start with no built guard, with one sentence that names the build, and compiles nothing', async () => {
    const root = rootOf();
    const manifest = path.join(root, 'dist', 'linux-socket-guard', 'linux-socket-guard', LINUX_SOCKET_GUARD_MANIFEST_ASSET);
    await expect(prebuiltLinuxSocketGuard(portsOf(root))()).rejects.toThrow(
      `the socket guard executable is not built: ${manifest} is missing; the packaging step builds it with node ${BUILDER}`,
    );
  });
});

describe('where the runtime gets its socket guard', () => {
  const embedded = (assets: Record<string, Uint8Array>) => ({ present: (name: string) => name in assets, raw: (name: string) => assets[name] as Uint8Array });
  const neverBuilt = (): (() => Promise<() => string>) => {
    throw new Error('no build is expected');
  };
  const extracted = hostExtractedLinuxSocketGuard;

  it('is nowhere on a host that is not Linux, and nowhere in a single executable that carries none', () => {
    expect(socketGuardSourceOf({ platform: 'darwin', embedded: undefined, prebuilt: neverBuilt, extracted })).toBeUndefined();
    expect(socketGuardSourceOf({ platform: 'win32', embedded: embedded({}), prebuilt: neverBuilt, extracted })).toBeUndefined();
    expect(socketGuardSourceOf({ platform: 'linux', embedded: embedded({}), prebuilt: neverBuilt, extracted })).toBeUndefined();
  });

  it('is extracted from the single executable under the executables area', async () => {
    const root = rootOf();
    const source = socketGuardSourceOf({
      platform: 'linux',
      embedded: embedded({ [LINUX_SOCKET_GUARD_MANIFEST_ASSET]: new TextEncoder().encode(MANIFEST), [LINUX_SOCKET_GUARD_BINARY_ASSET]: BINARY }),
      prebuilt: neverBuilt,
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
      prebuilt: (executablesRoot) => async () => {
        asked.push(executablesRoot);
        return () => '/built/guard';
      },
      extracted,
    });
    const guard = source?.({ executables: '/cache/executables' }, testLocks());

    expect(asked).toEqual([]);
    expect(await guard?.()).toBe('/built/guard');
    expect(asked).toEqual(['/cache/executables']);
  });
});
