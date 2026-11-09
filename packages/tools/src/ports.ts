import type { JobView } from '@momonga/protocol';
import type { SandboxedProcess } from '@momonga/sandbox';

export type ToolIdempotencyRecord = {
  key: string;
  state: 'PENDING' | 'UNKNOWN';
  meta: Record<string, unknown>;
  pgid?: number;
  startedAt?: number;
  leaseToken?: number;
  createdAt: number;
  expiresAt: number;
};

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
  authorise(key: string): LeasedOutcome;
  attachProcess(key: string, process: { pgid: number; startedAt: number }): LeasedOutcome;
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
  put(data: string | Uint8Array, options: { mediaType: string; runId?: string }): { handle: string; sha256: string; byteLength: number; lineCount: number };
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
  spawn(markerFile: string, signal: AbortSignal, markerFd?: number): SandboxedProcess;
};

export type BackgroundJobRead = { job: JobView; output: string };

export type BackgroundJobs = {
  start(request: BackgroundJobStart): Promise<{ jobId: string }>;
  byCall(callKey: string): JobView | undefined;
  status(runId: string, jobId: string): JobView;
  read(runId: string, jobId: string, options: { call: string; filter?: RegExp }): Promise<BackgroundJobRead>;
  kill(runId: string, jobId: string): Promise<JobView>;
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
