import fs from 'node:fs/promises';
import path from 'node:path';
import type { BundledRipgrep, BundledRipgrepResolver } from './ripgrep-distribution.ts';

export type RipgrepSource = 'bundled' | 'system' | 'path';

export type RipgrepLocation =
  | { ok: true; path: string; source: RipgrepSource; version?: string; release(): Promise<void> }
  | { ok: false; cause: string };

export type RipgrepLocator = { locate(signal: AbortSignal): Promise<RipgrepLocation> };

export type RipgrepLocatorPorts = {
  setting: string;
  bundled?: BundledRipgrepResolver | undefined;
  onPath(): Promise<string | undefined>;
  isRegularFile(file: string): Promise<boolean>;
};

export const RIPGREP_BASE_NAME = 'rg';

export const ripgrepUnavailableMessage = (cause: string): string =>
  `ripgrep is not available: ${cause}. Grep needs it. To use another ripgrep, set "tools.ripgrep" to "system" or to an absolute path in your user settings.`;

const NO_RELEASE = async (): Promise<void> => undefined;

const causeOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const fromPath = async (ports: RipgrepLocatorPorts, why: string): Promise<RipgrepLocation> => {
  const found = await ports.onPath();
  if (found === undefined) return { ok: false, cause: `no ${RIPGREP_BASE_NAME} was found on PATH (${why})` };
  return { ok: true, path: found, source: 'system', release: NO_RELEASE };
};

const fromBundled = async (bundled: BundledRipgrepResolver, signal: AbortSignal): Promise<RipgrepLocation> => {
  let extracted: BundledRipgrep;
  try {
    extracted = await bundled(signal);
  } catch (error) {
    return { ok: false, cause: causeOf(error) };
  }
  return { ok: true, path: extracted.path, source: 'bundled', version: extracted.version, release: extracted.release };
};

const fromAbsolute = async (ports: RipgrepLocatorPorts, file: string): Promise<RipgrepLocation> => {
  if (!(await ports.isRegularFile(file))) return { ok: false, cause: `the "tools.ripgrep" setting names ${file}, which is not a regular file` };
  return { ok: true, path: file, source: 'path', release: NO_RELEASE };
};

export const createRipgrepLocator = (ports: RipgrepLocatorPorts): RipgrepLocator => ({
  locate: async (signal) => {
    if (ports.setting === 'system') return fromPath(ports, '"tools.ripgrep" is "system"');
    if (ports.setting !== 'bundled') return fromAbsolute(ports, ports.setting);
    if (ports.bundled === undefined) return fromPath(ports, 'this executable embeds no ripgrep');
    return fromBundled(ports.bundled, signal);
  },
});

const executableNamesOf = (env: Readonly<Record<string, string>>): string[] => [
  RIPGREP_BASE_NAME,
  ...(env['PATHEXT'] ?? '')
    .split(';')
    .filter((extension) => extension !== '')
    .map((extension) => `${RIPGREP_BASE_NAME}${extension.toLowerCase()}`),
];

const isExecutableFile = async (candidate: string): Promise<boolean> => {
  try {
    await fs.access(candidate, fs.constants.X_OK);
    return (await fs.stat(candidate)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return false;
    throw error;
  }
};

export const findRipgrepOnPath = async (env: Readonly<Record<string, string>>): Promise<string | undefined> => {
  const names = executableNamesOf(env);
  for (const directory of (env['PATH'] ?? '').split(path.delimiter)) {
    if (directory === '' || !path.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
};

export const isRegularFileOnHost = async (file: string): Promise<boolean> => {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
};

export type HostRipgrepLocatorOptions = { setting: string; env: Readonly<Record<string, string>>; bundled?: BundledRipgrepResolver };

export const createHostRipgrepLocator = ({ setting, env, bundled }: HostRipgrepLocatorOptions): RipgrepLocator =>
  createRipgrepLocator({
    setting,
    ...(bundled === undefined ? {} : { bundled }),
    onPath: () => findRipgrepOnPath(env),
    isRegularFile: isRegularFileOnHost,
  });
