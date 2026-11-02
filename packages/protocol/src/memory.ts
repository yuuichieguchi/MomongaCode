export const MEMORY_SCOPES = ['user', 'project'] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_ORIGINS = ['trusted', 'untrusted'] as const;

export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

export type MemorySource = {
  sessionId: string;
  runId: string;
  step: number;
  callId: string;
  seq: number;
};

export type MemoryView = {
  id: string;
  scope: MemoryScope;
  origin: MemoryOrigin;
  project: string | null;
  text: string;
  source: MemorySource;
  createdAt: number;
  lastUsedAt: number;
};

export type MemoriesResponse = { memories: MemoryView[] };

export type MemoryResponse = { memory: MemoryView };
