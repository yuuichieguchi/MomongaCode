import { nodeFileSystemSync } from '@momonga/foundation';
import type { ResolvedTuiSettings, SandboxSetting } from './settings.ts';

export const FIVE_MINUTES_MS = 300_000;

export const DEFAULT_RETENTION_DAYS = 30;

export type LauncherSandbox = Exclude<SandboxSetting, 'none'>;

export type SandboxLauncher = { readonly kind: LauncherSandbox; readonly launcher: string };

export const SANDBOX_LAUNCHERS: readonly [SandboxLauncher, SandboxLauncher] = [
  { kind: 'seatbelt', launcher: '/usr/bin/sandbox-exec' },
  { kind: 'bubblewrap', launcher: '/usr/bin/bwrap' },
];

export const SANDBOX_LAUNCHERS_LOOKED_FOR = SANDBOX_LAUNCHERS.map(({ kind, launcher }) => `${launcher} (${kind})`).join(' and ');

export type LauncherCheck = (file: string) => boolean;

const ABSENT_LAUNCHER_CODES: ReadonlySet<string | undefined> = new Set(['ENOENT', 'ENOTDIR', 'EACCES']);

export const hostLauncherExecutable: LauncherCheck = (file) => {
  try {
    nodeFileSystemSync.accessSync(file, 'execute');
    return true;
  } catch (error) {
    if (ABSENT_LAUNCHER_CODES.has((error as NodeJS.ErrnoException).code)) return false;
    throw error;
  }
};

export const executableSandboxLauncher = (executable: LauncherCheck = hostLauncherExecutable): SandboxLauncher | undefined =>
  SANDBOX_LAUNCHERS.find(({ launcher }) => executable(launcher));

export const defaultSandboxSetting = (executable: LauncherCheck = hostLauncherExecutable): LauncherSandbox =>
  (executableSandboxLauncher(executable) ?? SANDBOX_LAUNCHERS[1]).kind;

export const defaultTuiSettings = (): ResolvedTuiSettings => ({ theme: 'auto', notify: 'off', screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true });

export const DEFAULT_AUTO_UPDATES = true;

export const DEFAULT_PLAINTEXT_TOKEN_FILES = false;

export const DEFAULT_ENABLE_ALL_PROJECT_MCP_SERVERS = false;

export const DEFAULT_NETWORK_ENVIRONMENT = true;

export const DEFAULT_CAPTURE_MESSAGE_CONTENT = false;
