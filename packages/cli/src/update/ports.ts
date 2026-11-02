import type { CommandRunner } from '@momonga/foundation';
import type { CliClock, SelfExecutable, Sink, SpawnDetached } from '../ports.ts';

export type HttpRequest = { headers: Readonly<Record<string, string>>; signal: AbortSignal };

export type HttpResponse = { status: number; body: AsyncIterable<Uint8Array> };

export type UpdateHttp = { get(url: string, request: HttpRequest): Promise<HttpResponse> };

export type StagedFile = { readonly path: string; write(chunk: Uint8Array): Promise<void>; close(): Promise<void> };

export type UpdateFs = {
  realpath(file: string): Promise<string>;
  modeOf(file: string): Promise<number>;
  stage(directory: string, mode: number): Promise<StagedFile>;
  publish(staged: string, target: string): Promise<void>;
  remove(file: string): Promise<void>;
  removeLeftovers(directory: string): Promise<void>;
};

export type UpdateLockHandle = { release(): void };

export type UpdateLock = { acquire(): Promise<UpdateLockHandle | undefined> };

export type UpdateStateStore = { read(): Promise<unknown>; write(state: unknown): Promise<void> };

export type DaemonProbe = { running(): Promise<boolean>; restartBoundMs(): Promise<number> };

export type UpdatePorts = {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  self: SelfExecutable;
  env: Readonly<Record<string, string>>;
  clock: CliClock;
  http: UpdateHttp;
  fs: UpdateFs;
  run: CommandRunner;
  lock: UpdateLock;
  state: UpdateStateStore;
  daemon: DaemonProbe;
  autoUpdates(): Promise<boolean>;
  spawnDetached: SpawnDetached;
  stderr: Sink;
};
