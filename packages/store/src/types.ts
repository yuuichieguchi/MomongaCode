import type { Clock, Redactor } from '@momonga/foundation';
import type {
  ElicitationAnswerRecord,
  ElicitationRequestView,
  JobStatus,
  ImageAttachment,
  PermissionMode,
  PermissionOption,
  RunEvent,
  RunEventPayload,
  RunState,
  RunStatus,
  SessionEvent,
  GoverningEnforcement,
  GoverningFactView,
  GoverningKind,
  MemoryEvidence,
  MemoryKind,
  MemoryOrigin,
  MemoryRecord,
  MemoryScope,
  StopReason,
  ToolKind,
} from '@momonga/protocol';

export type SessionMcpServers = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export type Session = {
  id: string;
  cwd: string;
  env: Record<string, string>;
  permissionMode: PermissionMode;
  modelAlias: string;
  bypassAllowed: boolean;
  additionalDirectories: readonly string[];
  mcpServers: SessionMcpServers;
  createdAt: number;
};

export type CreateSessionInput = {
  cwd: string;
  env: Record<string, string>;
  permissionMode: PermissionMode;
  modelAlias: string;
  bypassAllowed?: boolean;
  additionalDirectories?: readonly string[];
  mcpServers?: SessionMcpServers;
};

export type RunError = { code: string; message: string };

export type HistoryMode = 'inherit' | 'fresh';

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
  previousRunId: string | null;
  history: HistoryMode;
  parentRunId: string | null;
  parentCallId: string | null;
  error?: RunError;
};

export type CreateRunInput = {
  input: string;
  idempotencyKey?: string;
  requestDigest?: string;
  timeoutMs: number;
  limits: Record<string, unknown>;
  pins: Record<string, unknown>;
  history?: HistoryMode;
  skill?: { name: string; content: string };
  images?: ImageAttachment[];
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

export type NotFound = { kind: 'not_found' };

export type CreateRunResult = { kind: 'created' | 'existing'; run: Run } | NotFound | { kind: 'key_reused' };
export type RequestCancelResult = { kind: 'ok'; run: Run; changed: boolean } | NotFound;
export type SetPermissionModeResult = { kind: 'ok'; session: Session; changed: boolean } | NotFound;
export type SetSessionMcpServersResult = { kind: 'ok'; session: Session } | NotFound;
export type ResolveApprovalResult =
  | { kind: 'ok'; approval: Approval; run: Run }
  | NotFound
  | { kind: 'approval_not_pending'; status: Approval['status'] }
  | { kind: 'request_missing' }
  | { kind: 'run_cancelled' }
  | { kind: 'option_not_offered' };

export type HeartbeatResult = { kind: 'ok'; cancelRequested: boolean; status: ClaimStatus } | LeaseLost;
export type AppendResult = { kind: 'ok'; lastSeq: number } | LeaseLost;
export type RunMutationResult = { kind: 'ok'; run: Run } | LeaseLost | Conflict;
export type ServiceMutationResult = { kind: 'ok'; run: Run } | Conflict;
export type RequestApprovalResult = { kind: 'ok'; approval: Approval } | LeaseLost;
export type SnapshotResult = { kind: 'ok' } | LeaseLost | Conflict;
export type InheritContextResult = { kind: 'inherited' } | { kind: 'already' } | { kind: 'none' } | LeaseLost | Conflict;

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
  leaseToken?: number;
  createdAt: number;
  expiresAt: number;
};

export type IdempotencyBegin =
  | { s: 'NEW' }
  | { s: 'PENDING'; rec: IdempotencyRecord }
  | { s: 'UNKNOWN'; rec: IdempotencyRecord }
  | { s: 'COMPLETED'; result: unknown };

export type IdempotencyLookup = Exclude<IdempotencyBegin, { s: 'NEW' }>;

export type LeaseFence = Pick<Claim, 'runId' | 'workerId' | 'leaseToken'>;

export type LeasedBegin = IdempotencyBegin | { s: 'LEASE_LOST' };

export type LeasedOutcome = { kind: 'ok' } | LeaseLost;

export type LeasedIdempotency = {
  begin(key: string, options: { expiresAt: number; meta: Record<string, unknown> }): LeasedBegin;
  authorise(key: string): LeasedOutcome;
  attachProcess(key: string, process: { pgid: number; startedAt: number }): LeasedOutcome;
  checkpoint(key: string, state: Record<string, unknown> | undefined): LeasedOutcome;
  complete(key: string, result: unknown): LeasedOutcome;
};

export type IdempotencyStore = {
  get(key: string): IdempotencyLookup | undefined;
  holding(fence: LeaseFence): LeasedIdempotency;
  clearCheckpoint(key: string): void;
  begin(key: string, options: { expiresAt: number; meta: Record<string, unknown> }): IdempotencyBegin;
  attachProcess(key: string, process: { pgid: number; startedAt: number }): void;
  complete(key: string, result: unknown): void;
  markUnknown(key: string): void;
  markUnknownIfPending(key: string): boolean;
  purgeExpired(nowMs: number): number;
};

export type Approval = {
  id: string;
  runId: string;
  callId: string;
  kind: 'permission' | 'elicitation';
  status: 'pending' | 'resolved' | 'superseded' | 'expired' | 'withdrawn';
  options: PermissionOption[];
  server?: string;
  requests?: ElicitationRequestView[];
  responses?: Record<string, ElicitationAnswerRecord>;
  expiresAt: number;
  createdAt: number;
  optionId?: string;
  resolvedAt?: number;
  subjectDigest?: string;
};

export type ApprovalView = {
  id: string;
  runId: string;
  callId: string;
  status: Approval['status'];
  options: PermissionOption[];
  expiresAt: number;
  createdAt: number;
  suggestedRule?: string;
  toolCall: {
    callId: string;
    name: string;
    title: string;
    kind: ToolKind;
    rawInput: unknown;
    locations?: { path: string; line?: number }[];
  };
};

export type ElicitationView = {
  id: string;
  runId: string;
  callId: string;
  status: Approval['status'];
  server: string;
  requests: ElicitationRequestView[];
  expiresAt: number;
  createdAt: number;
  toolCall: { callId: string; name: string; title: string };
};

export type ResolveElicitationResult =
  | { kind: 'ok'; elicitation: Approval; run: Run }
  | NotFound
  | { kind: 'approval_not_pending'; status: Approval['status'] }
  | { kind: 'request_missing' }
  | { kind: 'run_cancelled' }
  | { kind: 'wrong_kind' };

export type ApprovalStore = {
  get(id: string): Approval | undefined;
  listPending(runId: string): Approval[];
};

export type BlobRef = { handle: string; sha256: string; byteLength: number; lineCount: number };
export type BlobLineRange = { lineStart: number; lineEnd: number };
export type BlobByteRange = { offset: number; length: number };
export type BlobSlice = { text: string; totalLines: number; totalBytes: number };
export type BlobByteSlice = BlobSlice & { offset: number; length: number };

export type BlobStore = {
  handleFor(content: string): string;
  put(data: string | Uint8Array, options: { mediaType: string; runId?: string }): BlobRef;
  read(handle: string, range: BlobLineRange, scope?: BlobScope): Promise<BlobSlice>;
  read(handle: string, range: BlobByteRange, scope?: BlobScope): Promise<BlobByteSlice>;
};

export type BlobScope = { runId: string };

export type TrustDecision = 'trusted' | 'untrusted';

export type TrustStore = {
  get(path: string): TrustDecision | undefined;
  decisionFor(path: string): { decision: TrustDecision | null; inheritedFrom?: string };
  set(path: string, decision: TrustDecision): void;
  clear(path: string): void;
};

export type { MemoryRecord };

export type SaveMemoryInput = {
  scope: MemoryScope;
  origin: MemoryOrigin;
  project: string | null;
  text: string;
  runId: string;
  step: number;
  callId: string;
  kind?: MemoryKind;
  supersedes?: readonly string[];
  evidence?: readonly MemoryEvidence[];
};

export type MemoryVisibility = { trusted: true; project: string } | { trusted: false };

export type MemoryInclude = 'live' | 'all';

export type MemoryStore = {
  save(input: SaveMemoryInput): { memory: MemoryRecord; created: boolean };
  get(id: string): MemoryRecord | undefined;
  list(filter?: { scope?: MemoryScope; project?: string }): MemoryRecord[];
  recall(visibility: MemoryVisibility): MemoryRecord[];
  search(visibility: MemoryVisibility, terms: readonly string[], options?: { include: MemoryInclude }): MemoryRecord[];
  matchingIds(visibility: MemoryVisibility, terms: readonly string[]): Set<string>;
  retire(id: string): { retired: boolean; memory: MemoryRecord } | undefined;
  history(id: string): MemoryRecord[];
  markUsed(ids: readonly string[]): void;
  stampContributed(ids: readonly string[]): void;
  delete(id: string): boolean;
};

export type AddGoverningFactInput = {
  kind: GoverningKind;
  target: string;
  text: string;
  scope: GoverningFactView['scope'];
  validUntil: number | null;
  supersedes: readonly string[];
  enforcement: GoverningEnforcement | null;
  source: { kind: 'command' } | { kind: 'proposal'; sessionId: string; runId: string; seq: number; callId: string };
};

export type GoverningFactStore = {
  add(input: AddGoverningFactInput): { fact: GoverningFactView; created: boolean };
  get(id: string): GoverningFactView | undefined;
  list(filter?: { project: string }): GoverningFactView[];
  retire(id: string): { retired: boolean; fact: GoverningFactView } | undefined;
  history(id: string): GoverningFactView[];
};

export type HistoryVisibility = { trusted: boolean; project: string };

export type HistoryScope = 'project' | 'all';

export type HistoryStepHit = { step: number; seqFrom: number; seqTo: number; snippet: string };

export type HistoryAnchor = {
  runId: string;
  sessionId: string;
  project: string;
  origin: MemoryOrigin;
  outcome: string;
  at: number;
  seqFrom: number;
  seqTo: number;
  snippet: string;
  steps: HistoryStepHit[];
};

export type HistoryQueryRequest = {
  query: string;
  scope: HistoryScope;
  scanLimit?: number;
  candidateLimit?: number;
  readDenied?: (path: string, project: string) => boolean;
};

export type HistoryQueryResult = { anchors: HistoryAnchor[]; searched?: number; withheld?: number };

export type HistoryReadRequest = {
  runId: string;
  step?: number;
  seqFrom?: number;
  seqTo?: number;
  limit: number;
  redactor: Redactor;
};

export type HistoryReadResult =
  | { kind: 'ok'; runId: string; project: string; origin: MemoryOrigin; events: RunEvent[]; callPaths: Record<string, string[]>; nextSeq: number | null }
  | { kind: 'not_visible' };

export type SearchStore = {
  indexBatch(options: { limit: number; redactor: Redactor; maxChars?: number }): { runs: number };
  visibleProjects(visibility: HistoryVisibility, scope: HistoryScope): string[];
  query(visibility: HistoryVisibility, request: HistoryQueryRequest): HistoryQueryResult;
  readRange(visibility: HistoryVisibility, request: HistoryReadRequest): HistoryReadResult;
  projectOf(visibility: HistoryVisibility, runId: string): string | undefined;
};

export type RuntimeStore = {
  createSession(input: CreateSessionInput): Session;
  getSession(id: string): Session | undefined;
  listSessions(filter?: { cwd?: string }): Session[];
  createRunAndEnqueue(sessionId: string, input: CreateRunInput): CreateRunResult;
  findRunByIdempotencyKey(sessionId: string, key: string): { run: Run; requestDigest: string | null } | undefined;
  sessionActivity(sessionId: string): { lastActivityAt: number; hasActiveRun: boolean } | undefined;
  checkIdentity(): void;
  getRun(id: string): Run | undefined;
  claim(workerId: string): Claim | null;
  heartbeat(claim: Claim): HeartbeatResult;
  append(claim: Claim, events: readonly RunEventPayload[]): AppendResult;
  transition(claim: Claim, from: readonly RunStatus[], to: RunStatus, patch?: StatusPatch): RunMutationResult;
  release(claim: Claim, to: RunStatus, availableAt?: number, options?: { refundAttempt?: boolean; awaits?: WaitTargets }): RunMutationResult;
  releaseLease(claim: Claim, options: { availableAt: number; refundAttempt?: boolean }): RunMutationResult;
  requestCancel(runId: string): RequestCancelResult;
  setPermissionMode(sessionId: string, mode: PermissionMode): SetPermissionModeResult;
  setSessionMcpServers(sessionId: string, servers: SessionMcpServers): SetSessionMcpServersResult;
  listRuns(sessionId: string, statuses?: readonly RunStatus[]): Run[];
  appendAsService(
    runId: string,
    expectedVersion: number,
    to: RunStatus | null,
    events: readonly RunEventPayload[],
    patch?: StatusPatch,
  ): ServiceMutationResult;
  readRunEvents(runId: string, afterSeq: number, limit: number): RunEvent[];
  readRunEventsOfTypes(runId: string, types: readonly RunEventPayload['type'][]): RunEvent[];
  lastTerminalRootRuns(project: string, limit: number): Run[];
  readSessionEvents(sessionId: string, afterId: number, limit: number): (RunEvent | SessionEvent)[];
  sessionMaxEventId(sessionId: string): number;
  load(runId: string): LoadedRun;
  requestApproval(
    claim: Claim,
    input: {
      callId: string;
      options: PermissionOption[];
      expiresAt: number;
      event: { subjectDigest: string; suggestedRule?: string };
    },
  ): RequestApprovalResult;
  resolveApproval(approvalId: string, optionId: string): ResolveApprovalResult;
  requestElicitation(
    claim: Claim,
    input: { callId: string; expiresAt: number; server: string; requests: ElicitationRequestView[] },
  ): RequestApprovalResult;
  resolveElicitation(elicitationId: string, responses: Record<string, ElicitationAnswerRecord>): ResolveElicitationResult;
  elicitationView(elicitationId: string): ElicitationView | undefined;
  pendingElicitationViews(runId: string): ElicitationView[];
  expireApprovals(nowMs: number): string[];
  terminalRunIdsWithCheckpoint(): string[];
  hasActiveRun(): boolean;
  approvalView(approvalId: string): ApprovalView | undefined;
  pendingApprovalViews(runId: string): ApprovalView[];
  writeSnapshot(claim: Claim, seq: number, state: RunState): SnapshotResult;
  inheritContext(claim: Claim, options: { mode: PermissionMode }): InheritContextResult;
  dataVersion(): number;
  createChildRun(input: ChildRunInput): CreateChildRunResult;
  listChildRuns(runId: string): Run[];
  treeTokens(runId: string): number;
  rootSessionId(sessionId: string): string;
  jobs: JobStore;
  idempotency: IdempotencyStore;
  approvals: ApprovalStore;
  blobs: BlobStore;
  trust: TrustStore;
  memories: MemoryStore;
  governing: GoverningFactStore;
  search: SearchStore;
  close(): void;
};

export type RuntimeStoreOptions = {
  path: string;
  home: string;
  clock: Clock;
  leaseMs: number;
  maxAttempts: number;
  maxTotalAttempts: number;
  onCommit?: (touched: { runId?: string; sessionId: string }[]) => void;
  contribution?: TerminalContribution;
};

export type ContributionPayload = Extract<RunEventPayload, { type: 'context.contribution' }>;

export type TerminalContribution = {
  eventTypes: readonly RunEventPayload['type'][];
  measure(input: {
    run: Run;
    events: readonly RunEvent[];
    memories: Pick<MemoryStore, 'get'>;
    governing: Pick<GoverningFactStore, 'get'>;
  }): ContributionPayload | undefined;
};

export type Job = {
  id: string;
  idemKey: string;
  sessionId: string;
  runId: string;
  callId: string;
  command: string;
  status: JobStatus;
  pgid?: number;
  exitCode?: number;
  signal?: string;
  outputHandle?: string;
  outputStart: number;
  outputTotal: number;
  readOffset: number;
  lastRead?: { call: string; from: number };
  startedAt: number;
  endedAt?: number;
};

export type StartJobInput = { id: string; idemKey: string; sessionId: string; runId: string; callId: string; command: string };

export type JobOutputRef = { handle: string; start: number; total: number };

export type JobResult = { status: Exclude<JobStatus, 'running'>; exitCode?: number; signal?: string; output?: JobOutputRef };

export type FinishJobResult = { kind: 'finished'; job: Job } | { kind: 'already_finished'; job: Job } | NotFound;

export type JobStore = {
  start(input: StartJobInput): { job: Job; created: boolean };
  attachProcess(id: string, pgid: number): void;
  get(id: string): Job | undefined;
  byIdemKey(idemKey: string): Job | undefined;
  listRunning(): Job[];
  listForSession(sessionId: string): Job[];
  finish(id: string, result: JobResult): FinishJobResult;
  advanceRead(id: string, offset: number, call: string): void;
};

export type ChildRunInput = {
  parentRunId: string;
  parentCallId: string;
  input: string;
  pins: Record<string, unknown>;
  modelAlias?: string;
};

export type CreateChildRunResult =
  | { kind: 'created' | 'existing'; run: Run; session: Session }
  | { kind: 'parent_not_active'; status: RunStatus | 'missing' };

export type WaitTargets = { runIds: readonly string[]; jobIds: readonly string[] };
