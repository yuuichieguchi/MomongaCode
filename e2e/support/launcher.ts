import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildRole, Launcher } from '@momonga/supervisor';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const BUNDLE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'bundle.ts');

export const ROLE_MAIN_PATH = path.join(REPO_ROOT, 'e2e', 'support', 'role-main.ts');

export type LauncherOverride = { script: string; args?: string[] };

export type LauncherOverrides = Partial<Record<ChildRole, LauncherOverride>>;

export const roleMainOverride = (role: ChildRole, version: string, args: readonly string[] = []): LauncherOverride => ({
  script: ROLE_MAIN_PATH,
  args: [role, version, ...args],
});

export const entryFileLauncher =
  (version: string, overrides: LauncherOverrides = {}): Launcher =>
  (role) => {
    const override = overrides[role] ?? roleMainOverride(role, version);
    return { command: process.execPath, args: [override.script, ...(override.args ?? [])] };
  };
