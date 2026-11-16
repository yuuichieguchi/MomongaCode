import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { WINDOWS_KEEPER_BINARY_ASSET, WINDOWS_KEEPER_COMPILER_MISSING_EXIT, WINDOWS_KEEPER_MANIFEST_ASSET, sha256Hex } from '@momonga/foundation';
import type { ReleaseTargetName, WindowsKeeperManifest } from '@momonga/foundation';
import { repoRoot } from './bundle.ts';

export const WINDOWS_KEEPER_SOURCE = `${repoRoot}native/windows-keeper/keeper.c`;
export const WINDOWS_KEEPER_BINARY_NAME = 'momonga-keeper.exe';
export const zigCacheDir = `${repoRoot}.cache/zig`;

export type WindowsKeeperTarget = { readonly zigTarget: string };

export const WINDOWS_KEEPER_TARGETS: Readonly<Partial<Record<ReleaseTargetName, WindowsKeeperTarget>>> = {
  'win-x64': { zigTarget: 'x86_64-windows-gnu' },
};

export type CompileCommand = { file: string; args: string[] };

export const compileCommandOf = (source: string, output: string, zigTarget: string): CompileCommand => ({
  file: 'zig',
  args: ['cc', '-target', zigTarget, '-municode', '-Os', '-s', '-Wall', '-Wextra', '-Werror', '-o', output, source, '-ladvapi32'],
});

export class WindowsCompilerMissingError extends Error {
  constructor(options: { cause: unknown }) {
    super('zig was not found on PATH, so the Windows keeper cannot be compiled; install zig (https://ziglang.org/download/) and put it on PATH', options);
    this.name = 'WindowsCompilerMissingError';
  }
}

const isMissingProgram = (error: unknown, program: string): boolean => {
  const { code, syscall } = error as NodeJS.ErrnoException;
  return code === 'ENOENT' && syscall === `spawnSync ${program}`;
};

export const compileWindowsProgram = (source: string, output: string, zigTarget: string): void => {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(zigCacheDir, { recursive: true });
  const { file, args } = compileCommandOf(source, output, zigTarget);
  try {
    execFileSync(file, args, { env: { ...process.env, ZIG_GLOBAL_CACHE_DIR: zigCacheDir, ZIG_LOCAL_CACHE_DIR: zigCacheDir }, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (error) {
    if (isMissingProgram(error, file)) throw new WindowsCompilerMissingError({ cause: error });
    throw error;
  }
};

export const buildWindowsKeeperAssets = async (workDir: string, target: ReleaseTargetName): Promise<Record<string, string>> => {
  const row = WINDOWS_KEEPER_TARGETS[target];
  if (row === undefined) return {};
  const directory = path.join(workDir, 'windows-keeper');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const binaryFile = path.join(directory, WINDOWS_KEEPER_BINARY_ASSET);
  compileWindowsProgram(WINDOWS_KEEPER_SOURCE, binaryFile, row.zigTarget);
  const binary = fs.readFileSync(binaryFile);
  const manifest: WindowsKeeperManifest = { target, binary: { asset: WINDOWS_KEEPER_BINARY_ASSET, sha256: sha256Hex(binary), size: binary.length, name: WINDOWS_KEEPER_BINARY_NAME } };
  const manifestFile = path.join(directory, WINDOWS_KEEPER_MANIFEST_ASSET);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  return { [WINDOWS_KEEPER_MANIFEST_ASSET]: manifestFile, [WINDOWS_KEEPER_BINARY_ASSET]: binaryFile };
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      'work-dir': { type: 'string', default: `${repoRoot}dist/windows-keeper` },
      target: { type: 'string', default: 'win-x64' },
    },
  });
  if (!Object.hasOwn(WINDOWS_KEEPER_TARGETS, values.target)) throw new Error(`unknown --target ${values.target}; expected one of ${Object.keys(WINDOWS_KEEPER_TARGETS).join(', ')}`);
  let assets: Record<string, string>;
  try {
    assets = await buildWindowsKeeperAssets(values['work-dir'], values.target as ReleaseTargetName);
  } catch (error) {
    if (!(error instanceof WindowsCompilerMissingError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(WINDOWS_KEEPER_COMPILER_MISSING_EXIT);
  }
  process.stdout.write(`${assets[WINDOWS_KEEPER_BINARY_ASSET]}\n`);
}
