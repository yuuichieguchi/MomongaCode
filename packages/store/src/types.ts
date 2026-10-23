import type { Clock } from '@momonga/foundation';
import type {
  PermissionMode,
  PermissionOption,
  RunEvent,
  RunEventPayload,
  RunState,
  RunStatus,
  StopReason,
} from '@momonga/protocol';

export type Session = {
  id: string;
  cwd: string;
  env: Record<string, string>;
  permissionMode: PermissionMode;
  modelAlias: string;
  createdAt: number;
};

export type CreateSessionInput = {
  cwd: string;
  env: Record<string, string>;
  permissionMode: PermissionMode;
  modelAlias: string;
};

export type RunError = { code: string; message: string };

export type Run = {
  id: string;
  sessionId: string;
  ordinal: number;
  status: RunStatus;
  stopReason?: StopReason;
  version: number;
  leaseOwner: string | null;
  leaseToken: number;
  leaseExpiresAt: number | null;
  availableAt: number;
  createdAt: number;
  attempts: number;
  failedAttempts: number;
  cancelRequested: boolean;
  deadLetter: boolean;
  deadlineAt: number;
  limits: Record<string, unknown>;
  pins: Record<string, unknown>;
  step: number;
  lastSeq: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  error?: RunError;
};

export type CreateRunInput = {
  input: string;
  idempotencyKey?: string;
  deadlineAt: number;
  limits: Record<string, unknown>;
  pins: Record<string, unknown>;
};

export type ClaimStatus = 'RUNNING' | 'CANCELLING';

export type Claim = {
  runId: string;
  sessionId: string;
  workerId: string;
  leaseToken: number;
  attempt: number;
  status: ClaimStatus;
};

export type LeaseLost = { kind: 'lease_lost' };
export type Conflict = { kind: 'conflict'; reason?: string };

export type HeartbeatResult = { kind: 'ok'; cancelRequested: boolean; status: ClaimStatus } | LeaseLost;
export type AppendResult = { kind: 'ok'; lastSeq: number } | LeaseLost;
export type RunMutationResult = { kind: 'ok'; run: Run } | LeaseLost | Conflict;
export type ServiceMutationResult = { kind: 'ok'; run: Run } | Conflict;
export type SnapshotResult = { kind: 'ok' } | LeaseLost | Conflict;

export type StatusPatch = { stopReason?: StopReason; error?: RunError };

export type LoadedRun = {
  snapshot?: { seq: number; state: RunState };
  tail: RunEvent[];
};

export type IdempotencyRecord = {
  key: string;
  state: 'PENDING' | 'UNKNOWN';
  meta: Record<string, unknown>;
  pgid?: number;
  startedAt?: number;
  createdAt: number;
  expiresAt: number;
};

export type IdempotencyBegin =
  | { s: 'NEW' }
  | { s: 'PENDING'; rec: IdempotencyRecord }
  | { s: 'UNKNOWN'; rec: IdempotencyRecord }
  | { s: 'COMPLETED'; result: unknown };

export type IdempotencyLookup = Exclude<IdempotencyBegin, { s: 'NEW' }>;

export type IdempotencyStore = {
  get(key: string): IdempotencyLookup | undefined;
  begin(key: string, options: { expiresAt: number; meta: Record<string, unknown> }): IdempotencyBegin;
  attachProcess(key: string, process: { pgid: number; startedAt: number }): void;
  complete(key: string, result: unknown): void;
  markUnknown(key: string): void;
  purgeExpired(nowMs: number): number;
};

export type Approval = {
  id: string;
  runId: string;
  callId: string;
  status: 'pending' | 'resolved';
  options: PermissionOption[];
  expiresAt: number;
  createdAt: number;
  optionId?: string;
  resolvedAt?: number;
};

export type ApprovalCreateResult = { kind: 'ok'; approval: Approval } | Conflict;
export type ApprovalResolveResult = { kind: 'ok'; approval: Approval } | Conflict;

export type ApprovalStore = {
  create(input: { runId: string; callId: string; options: PermissionOption[]; expiresAt: number }): ApprovalCreateResult;
  get(id: string): Approval | undefined;
  resolve(id: string, resolution: { optionId: string }): ApprovalResolveResult;
  listPending(runId: string): Approval[];
  listExpired(nowMs: number): Approval[];
};

export type BlobRef = { handle: string; sha256: string; byteLength: number; lineCount: number };
export type BlobLineRange = { lineStart: number; lineEnd: number };
export type BlobByteRange = { offset: number; length: number };
export type BlobSlice = { text: string; totalLines: number; totalBytes: number };
export type BlobByteSlice = BlobSlice & { offset: number; length: number };

export type BlobStore = {
  put(data: string | Uint8Array, options: { mediaType: string }): BlobRef;
  read(handle: string, range: BlobLineRange): Promise<BlobSlice>;
  read(handle: string, range: BlobByteRange): Promise<BlobByteSlice>;
};

export type TrustDecision = 'trusted' | 'untrusted';

export type TrustStore = {
  get(path: string): TrustDecision | undefined;
  set(path: string, decision: TrustDecision): void;
};

export type RuntimeStore = {
  createSession(input: CreateSessionInput): Session;
  getSession(id: string): Session | undefined;
  listSessions(filter?: { cwd?: string }): Session[];
  createRunAndEnqueue(sessionId: string, input: CreateRunInput): Run;
  getRun(id: string): Run | undefined;
  claim(workerId: string): Claim | null;
  heartbeat(claim: Claim): HeartbeatResult;
  append(claim: Claim, events: readonly RunEventPayload[]): AppendResult;
  transition(claim: Claim, from: readonly RunStatus[], to: RunStatus, patch?: StatusPatch): RunMutationResult;
  release(claim: Claim, to: RunStatus, availableAt?: number): RunMutationResult;
  requestCancel(runId: string): Run;
  appendAsService(
    runId: string,
    expectedVersion: number,
    to: RunStatus | null,
    events: readonly RunEventPayload[],
    patch?: StatusPatch,
  ): ServiceMutationResult;
  readRunEvents(runId: string, afterSeq: number, limit: number): RunEvent[];
  readSessionEvents(sessionId: string, afterId: number, limit: number): RunEvent[];
  load(runId: string): LoadedRun;
  writeSnapshot(claim: Claim, seq: number, state: RunState): SnapshotResult;
  idempotency: IdempotencyStore;
  approvals: ApprovalStore;
  blobs: BlobStore;
  trust: TrustStore;
  close(): void;
};

export type RuntimeStoreOptions = {
  path: string;
  clock: Clock;
  leaseMs: number;
  maxAttempts: number;
  maxTotalAttempts: number;
};
