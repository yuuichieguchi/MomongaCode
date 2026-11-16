import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { LINUX_SOCKET_GUARD_BINARY_ASSET, LINUX_SOCKET_GUARD_BINARY_NAME, LINUX_SOCKET_GUARD_COMPILER_MISSING_EXIT, LINUX_SOCKET_GUARD_MANIFEST_ASSET, releaseTargetOf, sha256Hex } from '@momonga/foundation';
import type { BundledExecutableManifest, ReleaseTargetName } from '@momonga/foundation';
import { repoRoot } from './bundle.ts';
import { zigCacheDir } from './windows-keeper.ts';
import type { CompileCommand } from './windows-keeper.ts';

export const LINUX_SOCKET_GUARD_SOURCE = `${repoRoot}native/linux-socket-guard/guard.c`;
export const LINUX_SOCKET_PROBE_SOURCE = `${repoRoot}native/linux-socket-guard/test/socket-probe.c`;

export const LINUX_SOCKET_GUARD_TARGETS: Readonly<Partial<Record<ReleaseTargetName, { readonly zigTarget: string }>>> = {
  'linux-x64': { zigTarget: 'x86_64-linux-musl' },
  'linux-arm64': { zigTarget: 'aarch64-linux-musl' },
};

export type LinuxCompiler = { readonly kind: 'zig'; readonly zigTarget: string } | { readonly kind: 'host' };

const COMPILE_FLAGS = ['-Os', '-s', '-Wall', '-Wextra', '-Werror', '-pthread'] as const;

export const linuxCompileCommandOf = (source: string, output: string, compiler: LinuxCompiler): CompileCommand =>
  compiler.kind === 'zig'
    ? { file: 'zig', args: ['cc', '-target', compiler.zigTarget, '-static', ...COMPILE_FLAGS, '-o', output, source] }
    : { file: 'cc', args: [...COMPILE_FLAGS, '-o', output, source] };

export const compileLinuxProgram = (source: string, output: string, compiler: LinuxCompiler): void => {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(zigCacheDir, { recursive: true });
  const { file, args } = linuxCompileCommandOf(source, output, compiler);
  execFileSync(file, args, { env: { ...process.env, ZIG_GLOBAL_CACHE_DIR: zigCacheDir, ZIG_LOCAL_CACHE_DIR: zigCacheDir }, stdio: ['ignore', 'inherit', 'inherit'] });
};

export const linuxCompilerMissing = (error: unknown): boolean => {
  const { code, syscall } = error as NodeJS.ErrnoException;
  return code === 'ENOENT' && (syscall === 'spawnSync zig' || syscall === 'spawnSync cc');
};

export const crossCompilerOf = (target: ReleaseTargetName): LinuxCompiler | undefined => {
  const row = LINUX_SOCKET_GUARD_TARGETS[target];
  return row === undefined ? undefined : { kind: 'zig', zigTarget: row.zigTarget };
};

export const buildLinuxSocketGuardAssets = async (workDir: string, target: ReleaseTargetName, compiler: LinuxCompiler | undefined = crossCompilerOf(target)): Promise<Record<string, string>> => {
  if (compiler === undefined || LINUX_SOCKET_GUARD_TARGETS[target] === undefined) return {};
  const directory = path.join(workDir, 'linux-socket-guard');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const binaryFile = path.join(directory, LINUX_SOCKET_GUARD_BINARY_ASSET);
  compileLinuxProgram(LINUX_SOCKET_GUARD_SOURCE, binaryFile, compiler);
  const binary = fs.readFileSync(binaryFile);
  const manifest: BundledExecutableManifest = { target, binary: { asset: LINUX_SOCKET_GUARD_BINARY_ASSET, sha256: sha256Hex(binary), size: binary.length, name: LINUX_SOCKET_GUARD_BINARY_NAME } };
  const manifestFile = path.join(directory, LINUX_SOCKET_GUARD_MANIFEST_ASSET);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  return { [LINUX_SOCKET_GUARD_MANIFEST_ASSET]: manifestFile, [LINUX_SOCKET_GUARD_BINARY_ASSET]: binaryFile };
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      'work-dir': { type: 'string', default: `${repoRoot}dist/linux-socket-guard` },
      target: { type: 'string' },
      compiler: { type: 'string', default: 'zig' },
    },
  });
  const target = values.target ?? releaseTargetOf(process.platform, process.arch);
  if (target === undefined || !Object.hasOwn(LINUX_SOCKET_GUARD_TARGETS, target)) {
    throw new Error(`the socket guard is built for ${Object.keys(LINUX_SOCKET_GUARD_TARGETS).join(' and ')}, not for ${values.target ?? `${process.platform}-${process.arch}`}`);
  }
  if (values.compiler !== 'zig' && values.compiler !== 'host') throw new Error(`unknown --compiler ${values.compiler}; expected zig or host`);
  const compiler: LinuxCompiler | undefined = values.compiler === 'host' ? { kind: 'host' } : crossCompilerOf(target as ReleaseTargetName);
  let assets: Record<string, string>;
  try {
    assets = await buildLinuxSocketGuardAssets(values['work-dir'], target as ReleaseTargetName, compiler);
  } catch (error) {
    if (!linuxCompilerMissing(error)) throw error;
    process.stderr.write(`${values.compiler === 'host' ? 'cc' : 'zig'} was not found on PATH, so the socket guard cannot be compiled\n`);
    process.exit(LINUX_SOCKET_GUARD_COMPILER_MISSING_EXIT);
  }
  process.stdout.write(`${assets[LINUX_SOCKET_GUARD_BINARY_ASSET]}\n`);
}
