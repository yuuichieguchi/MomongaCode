import type { SecretStore } from '@momonga/foundation';

export type CliClock = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

export type DetachedExit = { code: number | null; signal: NodeJS.Signals | null };

export type DetachedSpawn = {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
};

export type DetachedChild = { exit: Promise<DetachedExit> };

export type SpawnDetached = (spec: DetachedSpawn) => DetachedChild;

export type SelfExecutable =
  | { kind: 'single-binary'; execPath: string }
  | { kind: 'script'; execPath: string; script: string };

export type Sink = { write(text: string): void };

export type Terminal = { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream };

export type CliFiles = {
  readBytes(file: string): Promise<Uint8Array>;
  readText(file: string): Promise<string>;
  writeText(file: string, text: string): Promise<void>;
  listFiles(directory: string): Promise<string[]>;
  ensureDirectory(directory: string): Promise<void>;
  makeTempDirectory(prefix: string): Promise<string>;
  removeTree(directory: string): Promise<void>;
};

export type CliPorts = {
  version: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  home: string;
  stdout: Sink;
  stderr: Sink;
  clock: CliClock;
  random: () => number;
  self: SelfExecutable;
  spawnDetached: SpawnDetached;
  terminal: Terminal | undefined;
  files: CliFiles;
  openUrl(url: URL, signal: AbortSignal): Promise<void>;
  secretStore(): SecretStore;
};
