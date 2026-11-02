import type { MemoryKind, MemoryScope, MemoryView } from '@momonga/protocol';

export type MemorySaveRequest = {
  scope: MemoryScope;
  text: string;
  runId: string;
  step: number;
  callId: string;
  signal: AbortSignal;
  kind?: MemoryKind;
  paths?: string[];
  supersedes?: string[];
};

export type MemorySearchOptions = { include: 'live' | 'all'; signal: AbortSignal };

export type MemoryStorePort = {
  save(request: MemorySaveRequest): { memory: MemoryView; created: boolean } | Promise<{ memory: MemoryView; created: boolean }>;
  search(terms: readonly string[], options: MemorySearchOptions): MemoryView[] | Promise<MemoryView[]>;
};

export type MemoryToolsOptions = { port: MemoryStorePort; trusted: boolean };
