import type { MemoryScope, MemoryView } from '@momonga/protocol';

export type MemorySaveRequest = { scope: MemoryScope; text: string; runId: string; step: number; callId: string };

export type MemoryStorePort = {
  save(request: MemorySaveRequest): { memory: MemoryView; created: boolean };
  search(terms: readonly string[]): MemoryView[];
};

export type MemoryToolsOptions = { port: MemoryStorePort; trusted: boolean };
