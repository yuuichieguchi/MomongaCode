import type { ResolvedTuiSettings, SandboxSetting } from './settings.ts';

export const FIVE_MINUTES_MS = 300_000;

export const DEFAULT_RETENTION_DAYS = 30;

export const defaultSandboxSetting = (platform: NodeJS.Platform = process.platform): SandboxSetting =>
  platform === 'darwin' ? 'seatbelt' : platform === 'linux' ? 'bubblewrap' : 'none';

export const defaultTuiSettings = (): ResolvedTuiSettings => ({ theme: 'auto', notify: 'off', screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true });

export const DEFAULT_AUTO_UPDATES = true;

export const DEFAULT_PLAINTEXT_TOKEN_FILES = false;

export const DEFAULT_ENABLE_ALL_PROJECT_MCP_SERVERS = false;

export const DEFAULT_NETWORK_ENVIRONMENT = true;

export const DEFAULT_CAPTURE_MESSAGE_CONTENT = false;
