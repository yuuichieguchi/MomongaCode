import type { Stored, UNKNOWN_VALUE } from './stored-value.ts';
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
  | { kind: 'check'; runId: string; conditionId: string; seq: number; command: string; exitCode: number };

export type StoredMemorySource = MemorySource | { kind: typeof UNKNOWN_VALUE };

export type ModelCallCheckEvidence = { kind: 'check'; runId: string; modelCallId: string; seq: number; command: string; exitCode: number };

export type StoredMemoryEvidence = MemoryEvidence | ModelCallCheckEvidence | { kind: typeof UNKNOWN_VALUE };

export type MemoryRecord = {
  id: string;
  scope: Stored<MemoryScope>;
  origin: Stored<MemoryOrigin>;
  project: string | null;
  text: string;
  source: StoredMemorySource;
  createdAt: number;
  keptAt: number;
  kind: Stored<MemoryKind>;
  state: Stored<MemoryState>;
  duplicateOf: string | null;
  supersedes: string[];
  supersededBy: string[];
  retiredAt: number | null;
  evidence: StoredMemoryEvidence[];
  contributedAt: number | null;
  observedStatus: Stored<MemoryStatus> | null;
};

export const VALIDITY_CLOSERS = ['observation', 'successor', 'retirement'] as const;

export type ValidityCloser = (typeof VALIDITY_CLOSERS)[number];

export type ValidityInterval = { status: Stored<MemoryStatus>; from: number; to: number | null; closedBy: ValidityCloser | null };

export type ValidityChange = { from: Stored<MemoryStatus>; to: Stored<MemoryStatus>; changedBetween: [number, number] };

export type MemoryValidity = { intervals: ValidityInterval[]; changes: ValidityChange[] };

export type MemoryView = Omit<MemoryRecord, 'observedStatus'> & { status: MemoryStatus; observedStatus?: Stored<MemoryStatus> | null; validity?: MemoryValidity };

export const describeMemoryValidity = (memory: Pick<MemoryRecord, 'state' | 'retiredAt' | 'supersedes' | 'supersededBy'>): string =>
  [
    ...(memory.state === 'active' ? [] : [`state ${memory.state}`]),
    ...(memory.retiredAt === null ? [] : [`retired ${new Date(memory.retiredAt).toISOString()}`]),
    ...(memory.supersedes.length === 0 ? [] : [`supersedes ${memory.supersedes.join(' ')}`]),
    ...(memory.supersededBy.length === 0 ? [] : [`superseded by ${memory.supersededBy.join(' ')}`]),
  ]
    .map((part) => `, ${part}`)
    .join('');

const iso = (at: number): string => new Date(at).toISOString();

export const describeValidity = (validity: MemoryValidity): string =>
  validity.intervals
    .map((interval) => {
      const until = interval.to === null ? 'now' : `${iso(interval.to)}${interval.closedBy === 'observation' ? '' : ` (${interval.closedBy})`}`;
      return `${interval.status} observed ${iso(interval.from)} to ${until}`;
    })
    .join('; ');

export type AddMemoryRequest = {
  text: string;
  scope: MemoryScope;
  project?: string;
  kind?: MemoryKind;
  paths?: string[];
};

export const REFLECTION_DROP_CAUSES = ['text_rule', 'duplicate', 'evidence'] as const;

export type ReflectionDropCause = (typeof REFLECTION_DROP_CAUSES)[number];

export type ReflectionDrop = { ordinal: number; text: string | null; cause: ReflectionDropCause; reason: string };

export const REFLECTION_JOB_STATES = ['pending', 'running', 'done', 'failed'] as const;

export type ReflectionJobState = (typeof REFLECTION_JOB_STATES)[number];

export type ReflectionJobView = {
  runId: string;
  state: Stored<ReflectionJobState>;
  attempts: number;
  reason: string | null;
  dropped: ReflectionDrop[];
  updatedAt: number;
};

export type ReflectionResponse = { job: ReflectionJobView | null };

export type MemoriesResponse = { memories: MemoryView[]; next?: string | null };

export type MemoryResponse = { memory: MemoryView };

export type PromoteMemoryRequest = { skill: string };

export type PromoteMemoryResponse = { path: string };
