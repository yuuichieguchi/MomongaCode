import type { JobView } from '@momonga/protocol';
import type { SandboxedProcess } from '@momonga/sandbox';

export type ToolIdempotencyRecord = {
  key: string;
  state: 'PENDING' | 'UNKNOWN';
  meta: Record<string, unknown>;
  pgid?: number;
  startedAt?: number;
  createdAt: number;
  expiresAt: number;
};

export type ToolIdempotencyLookup =
  | { s: 'PENDING'; rec: ToolIdempotencyRecord }
  | { s: 'UNKNOWN'; rec: ToolIdempotencyRecord }
  | { s: 'COMPLETED'; result: unknown };

export type ToolIdempotencyBegin = { s: 'NEW' } | ToolIdempotencyLookup;

export type IdempotencyPort = {
  get(key: string): ToolIdempotencyLookup | undefined;
  begin(key: string, options: { expiresAt: number; meta: Record<string, unknown> }): ToolIdempotencyBegin;
  attachProcess(key: string, process: { pgid: number; startedAt: number }): void;
  checkpoint(key: string, state: Record<string, unknown> | undefined): void;
  complete(key: string, result: unknown): void;
  markUnknown(key: string): void;
  markUnknownIfPending(key: string): boolean;
};

export type BlobPort = {
  put(data: string | Uint8Array, options: { mediaType: string }): { handle: string; sha256: string; byteLength: number; lineCount: number };
  read(handle: string, range: { lineStart: number; lineEnd: number }): Promise<{ text: string; totalLines: number; totalBytes: number }>;
  read(
    handle: string,
    range: { offset: number; length: number },
  ): Promise<{ text: string; totalLines: number; totalBytes: number; offset: number; length: number }>;
};

export type BackgroundJobStart = {
  runId: string;
  callKey: string;
  callId: string;
  command: string;
  timeoutMs: number;
  spawn(markerFile: string, signal: AbortSignal): SandboxedProcess;
};

export type BackgroundJobRead = { job: JobView; output: string };

export type BackgroundJobs = {
  start(request: BackgroundJobStart): Promise<{ jobId: string }>;
  byCall(callKey: string): JobView | undefined;
  status(runId: string, jobId: string): JobView;
  read(runId: string, jobId: string, options: { filter?: RegExp }): Promise<BackgroundJobRead>;
  kill(runId: string, jobId: string): Promise<JobView>;
};
