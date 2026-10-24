import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildRole, Launcher } from '@momonga/supervisor';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ROLE_BIN_PATHS: Readonly<Record<ChildRole, string>> = {
  runtime: path.join(REPO_ROOT, 'packages', 'runtime', 'src', 'bin.ts'),
  gateway: path.join(REPO_ROOT, 'packages', 'gateway', 'src', 'bin.ts'),
};

export type LauncherOverride = { script: string; args?: string[] };

export type LauncherOverrides = Partial<Record<ChildRole, LauncherOverride>>;

export const entryFileLauncher =
  (overrides: LauncherOverrides = {}): Launcher =>
  (role) => {
    const override = overrides[role];
    if (override === undefined) return { command: process.execPath, args: [ROLE_BIN_PATHS[role]] };
    return { command: process.execPath, args: [override.script, ...(override.args ?? [])] };
  };
