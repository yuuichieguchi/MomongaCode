import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { ChildProtection, MarkerMode } from '@momonga/foundation';
import type { JobView } from '@momonga/protocol';
import type { SandboxedProcess } from '@momonga/sandbox';

export type PortChild = EventEmitter & {
  stdout: Readable | null | undefined;
  stderr: Readable | null | undefined;
  kill(signal: NodeJS.Signals): boolean;
  unref(): void;
};

export type ChildSpawnOptions = { cwd?: string; env: Readonly<Record<string, string>>; signal?: AbortSignal };

export type ChildPorts = {
  spawn(file: string, args: readonly string[], options: ChildSpawnOptions): PortChild;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type ToolTimers = Pick<ChildPorts, 'setTimeout' | 'clearTimeout'>;

export type ChildLaunch = { protection: ChildProtection; commandOf(argv: readonly string[], scratch: readonly string[]): { file: string; args: string[] } };

export type ToolIdempotencyRecord = {
  key: string;
  state: 'PENDING' | 'UNKNOWN';
  meta: Record<string, unknown>;
  pgid?: number;
  groupName?: string;
  startedAt?: number;
  leaseToken?: number;
  authorisedAt?: number;
  createdAt: number;
  expiresAt: number;
};

export type AttachedProcess = { pgid: number; startedAt: number; groupName?: string };

export type ToolIdempotencyLookup =
  | { s: 'PENDING'; rec: ToolIdempotencyRecord }
  | { s: 'UNKNOWN'; rec: ToolIdempotencyRecord }
  | { s: 'COMPLETED'; result: unknown };

export type ToolIdempotencyBegin = { s: 'NEW' } | ToolIdempotencyLookup;

export type LeaseFence = { runId: string; workerId: string; leaseToken: number };

export type LeasedBegin = ToolIdempotencyBegin | { s: 'LEASE_LOST' };

export type LeasedOutcome = { kind: 'ok' } | { kind: 'lease_lost' };

export type LeasedIdempotencyPort = {
  begin(key: string, options: { expiresAt: number; meta: Record<string, unknown> }): LeasedBegin;
  authorise(key: string, purpose?: 'reconcile'): LeasedOutcome;
  attachProcess(key: string, process: AttachedProcess): LeasedOutcome;
  checkpoint(key: string, state: Record<string, unknown> | undefined): LeasedOutcome;
  complete(key: string, result: unknown, meta?: Record<string, unknown>): LeasedOutcome;
};

export type IdempotencyPort = {
  get(key: string): ToolIdempotencyLookup | undefined;
  processGroupOf(key: string): number | undefined;
  holding(fence: LeaseFence): LeasedIdempotencyPort;
  clearCheckpoint(key: string): void;
  markUnknown(key: string): void;
  markUnknownIfPending(key: string): boolean;
};

export type BlobPort = {
  put(data: string | Uint8Array, options: { mediaType: string; runId?: string }): Promise<{ handle: string; sha256: string; byteLength: number; lineCount: number }>;
  read(handle: string, range: { lineStart: number; lineEnd: number }, scope?: { runId: string }): Promise<{ text: string; totalLines: number; totalBytes: number }>;
  read(
    handle: string,
    range: { offset: number; length: number },
    scope?: { runId: string },
  ): Promise<{ text: string; totalLines: number; totalBytes: number; offset: number; length: number }>;
};

export type BackgroundJobStart = {
  runId: string;
  callKey: string;
  callId: string;
  command: string;
  timeoutMs: number;
  spawn(markerFile: string, signal: AbortSignal, markerFd?: number): SandboxedProcess | Promise<SandboxedProcess>;
};

export type AdoptedOutput = { seen: Uint8Array; follow(sink: (chunk: Buffer) => void): Promise<void> };

export type BackgroundJobAdopt = {
  runId: string;
  callKey: string;
  callId: string;
  command: string;
  timeoutMs: number;
  process: SandboxedProcess;
  marker: { file: string; mode: MarkerMode };
  output: AdoptedOutput;
};

export type BackgroundJobRead = { job: JobView; output: string };

export type BackgroundJobKill = { view: JobView; kill: 'stopped' | 'requested' };

export class RetiringYield extends Error {
  constructor() {
    super('this generation is retiring and starts no new work; the run is yielded to the serving generation');
    this.name = 'RetiringYield';
  }
}

export type LineFilter = (lines: readonly string[]) => Promise<readonly string[]>;

export type BackgroundJobs = {
  start(request: BackgroundJobStart): Promise<{ jobId: string }>;
  adopt(request: BackgroundJobAdopt): Promise<{ jobId: string }>;
  byCall(callKey: string): JobView | undefined;
  status(runId: string, jobId: string): JobView;
  read(runId: string, jobId: string, options: { call: string; keep?: LineFilter }): Promise<BackgroundJobRead>;
  kill(runId: string, jobId: string): Promise<BackgroundJobKill>;
};

export type AutoClassifierRequest = {
  callId: string;
  toolName: string;
  title: string;
  input: unknown;
  reason: string;
  subjectDigest: string;
};

export type AutoClassifier = { classify(request: AutoClassifierRequest): Promise<'allow' | 'ask'> };
