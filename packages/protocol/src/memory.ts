export const MEMORY_SCOPES = ['user', 'project'] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_ORIGINS = ['trusted', 'untrusted'] as const;

export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

export type MemorySource =
  | { kind: 'tool'; sessionId: string; runId: string; step: number; callId: string; seq: number }
  | { kind: 'reflection'; sessionId: string; runId: string; ordinal: number }
  | { kind: 'command'; at: number };

export const MEMORY_KINDS = ['fact', 'episode', 'procedure'] as const;

export const DEFAULT_MEMORY_KIND = 'fact' as const satisfies (typeof MEMORY_KINDS)[number];

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATES = ['active', 'candidate', 'archived', 'duplicate', 'rejected'] as const;

export type MemoryState = (typeof MEMORY_STATES)[number];

export const MEMORY_EVIDENCE_KINDS = ['file', 'commit', 'check'] as const;

export type MemoryEvidenceKind = (typeof MEMORY_EVIDENCE_KINDS)[number];

export const MEMORY_STATUSES = ['verified', 'unbound', 'unverifiable', 'stale'] as const;

export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export type MemoryEvidence =
  | { kind: 'file'; project: string; path: string; sha256: string }
  | { kind: 'commit'; sha: string }
  | { kind: 'check'; runId: string; callId: string; seq: number; command: string; exitCode: number };

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  origin: MemoryOrigin;
  project: string | null;
  text: string;
  source: MemorySource;
  createdAt: number;
  lastUsedAt: number;
  kind: MemoryKind;
  state: MemoryState;
  duplicateOf: string | null;
  supersedes: string[];
  supersededBy: string[];
  retiredAt: number | null;
  evidence: MemoryEvidence[];
  contributedAt: number | null;
};

export type MemoryView = MemoryRecord & { status: MemoryStatus };

export const describeMemoryValidity = (memory: Pick<MemoryRecord, 'state' | 'retiredAt' | 'supersedes' | 'supersededBy'>): string =>
  [
    ...(memory.state === 'active' ? [] : [`state ${memory.state}`]),
    ...(memory.retiredAt === null ? [] : [`retired ${new Date(memory.retiredAt).toISOString()}`]),
    ...(memory.supersedes.length === 0 ? [] : [`supersedes ${memory.supersedes.join(' ')}`]),
    ...(memory.supersededBy.length === 0 ? [] : [`superseded by ${memory.supersededBy.join(' ')}`]),
  ]
    .map((part) => `, ${part}`)
    .join('');

export type AddMemoryRequest = {
  text: string;
  scope: MemoryScope;
  project?: string;
  kind?: MemoryKind;
  paths?: string[];
};

export type MemoriesResponse = { memories: MemoryView[] };

export type MemoryResponse = { memory: MemoryView };

export type PromoteMemoryRequest = { skill: string };

export type PromoteMemoryResponse = { path: string };
