import type { FileSystem, HostExec, OpenUrl, SecretStore } from '@momonga/foundation';
import type { HandoverHost } from './handover/host.ts';

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
  lifeline?: boolean;
};

export type DetachedChild = { exit: Promise<DetachedExit>; releaseLifeline?: () => void };

export type SpawnDetached = (spec: DetachedSpawn) => DetachedChild;

export type SelfExecutable =
  | { kind: 'single-binary'; execPath: string }
  | { kind: 'script'; execPath: string; script: string };

export type Sink = { write(text: string): void };

export type AcpStdio = { input: ReadableStream<Uint8Array>; output: WritableStream<Uint8Array> };

export type Terminal = { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream };

export type CliFiles = Pick<FileSystem, 'readFile' | 'readTextFile' | 'stat' | 'mkdir' | 'mkdirPrivate' | 'mkdtemp' | 'rm' | 'rename'> & {
  readText(file: string): Promise<string>;
  writeText(file: string, text: string): Promise<void>;
  listFiles(directory: string): Promise<string[]>;
  readTextIfPresent(file: string): Promise<string | undefined>;
  appendText(file: string, text: string, modes: { directory: number; file: number }): Promise<void>;
  exists(file: string): Promise<boolean>;
  writeTextAtomically(file: string, text: string, mode: number): Promise<void>;
};

export type CliPorts = {
  version: string;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  home: string;
  interrupt?: AbortSignal | undefined;
  stdout: Sink;
  stderr: Sink;
  clock: CliClock;
  random: () => number;
  self: SelfExecutable;
  spawnDetached: SpawnDetached;
  terminal: Terminal | undefined;
  files: CliFiles;
  exec: HostExec;
  openUrl: OpenUrl;
  secretStore(): SecretStore;
  acpStdio?: () => AcpStdio;
  handover?: HandoverHost;
};
