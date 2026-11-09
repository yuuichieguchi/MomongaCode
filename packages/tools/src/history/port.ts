import type { MemoryOrigin, RunEvent, Stored } from '@momonga/protocol';

export type HistoryScope = 'project' | 'all';

export type ReadDenial = (path: string) => boolean;

export type HistorySearchRequest = { query: string; scope: HistoryScope };

export type HistoryStepHit = { step: number; seqFrom: number; seqTo: number; snippet: string };

export type HistoryAnchor = {
  runId: string;
  sessionId: string;
  project: string;
  origin: Stored<MemoryOrigin>;
  outcome: string;
  at: number;
  seqFrom: number;
  seqTo: number;
  snippet: string;
  steps: HistoryStepHit[];
};

export type HistorySession = { sessionId: string; project: string; span: { from: number; to: number }; runs: HistoryAnchor[] };

export type HistorySearchResult = { sessions: HistorySession[]; searched?: number; withheld?: number };

export type HistoryReadRequest = { runId: string; step?: number; seqFrom?: number; seqTo?: number };

export type HistoryReadPage = {
  runId: string;
  project: string;
  origin: Stored<MemoryOrigin>;
  events: RunEvent[];
  callPaths: Readonly<Record<string, readonly string[]>>;
  nextSeq: number | null;
};

export type HistoryStorePort = {
  search(request: HistorySearchRequest): Promise<HistorySearchResult>;
  read(request: HistoryReadRequest): Promise<HistoryReadPage | null>;
  projectOf(runId: string): string | undefined;
  readDenial(project: string): Promise<ReadDenial>;
  redact(text: string): string;
};

export type HistoryToolsOptions = { port: HistoryStorePort; trusted: boolean; project: string };
