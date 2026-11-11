import type { WorkspaceFiles, WorkspaceProbe } from '@momonga/eval';
import type { FileSystem, HostExec, OpenUrl, ProcessPort, SecretStore, Timing } from '@momonga/foundation';
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

export type AcpInput = { take(): Uint8Array | undefined; arrival(): Promise<'bytes' | 'end'>; pause(): void; resume(): void };

export type AcpStdio = { input: AcpInput; output: WritableStream<Uint8Array> };

export type Terminal = { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream };

export type CliTimers = Pick<Timing, 'setTimeout' | 'clearTimeout'>;

export type StandardInput = { isTerminal: boolean; bytes(): AsyncIterable<Uint8Array> };

export type CliFiles = Pick<FileSystem, 'readFile' | 'readTextFile' | 'stat' | 'mkdir' | 'mkdirPrivate' | 'mkdtemp' | 'rm' | 'rename'> & WorkspaceFiles & {
  copyTreeVerbatim(from: string, to: string): Promise<void>;
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
  interrupt: AbortSignal;
  stdout: Sink;
  stderr: Sink;
  stdin: StandardInput;
  clock: CliClock;
  timers: CliTimers;
  random: () => number;
  uuid: () => string;
  process: ProcessPort;
  tmpdir: string;
  self: SelfExecutable;
  spawnDetached: SpawnDetached;
  terminal: Terminal | undefined;
  files: CliFiles;
  exec: HostExec;
  probe(env: Readonly<Record<string, string>>): WorkspaceProbe;
  openUrl: OpenUrl;
  secretStore(): SecretStore;
  personCapability(): Promise<string>;
  acpStdio?: () => AcpStdio;
  handover?: HandoverHost;
};
