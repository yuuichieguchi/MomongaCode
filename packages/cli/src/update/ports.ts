import type { BoundedCommandRunner } from '@momonga/foundation';
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

export type UpdateLock = { acquire(): Promise<UpdateLockHandle | undefined>; isHeld(): Promise<boolean> };

export type UpdateStateStore = { readonly file: string; read(): Promise<string | undefined>; write(state: unknown): Promise<void> };

export type RetiringWork = { steps: number; jobs: number; versions: string[]; notKnown: string[] };

export type DaemonProbe = { running(): Promise<boolean>; retiring(): Promise<RetiringWork>; readyBoundMs(): Promise<number> };

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
  run: BoundedCommandRunner;
  lock: UpdateLock;
  state: UpdateStateStore;
  daemon: DaemonProbe;
  autoUpdates(): Promise<boolean>;
  spawnDetached: SpawnDetached;
  stderr: Sink;
  watch?(onChange: () => void): () => void;
};
