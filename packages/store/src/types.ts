import type { RuleVerdictStore } from './rule-verdicts.ts';
import type { Stored, UNKNOWN_VALUE } from './rows.ts';
import type { Clock, FileSystem, Random, Redactor, KernelLockMechanism, SandboxNetworkSetting } from '@momonga/foundation';
import type { CANCEL_ORIGINS } from './transitions.ts';
import type { PermissionReviewsStore } from './permission-reviews.ts';
import type { InheritPlanReply, InheritPlanRequest, InheritedWindowReply, InheritedWindowRequest } from './inherit-reference.ts';
import type { UnaskedCommands } from './inherit.ts';
import type {
  CallFootprint,
  BilledDetail,
  Capabilities,
  CallTiming,
  ClaimedToken,
  TokenAnatomy,
  RunTracePrefix,
  ElicitationAnswerRecord,
  ElicitationRequestView,
  JobStatus,
  ImageAttachment,
  Mandate,
  MessageAttachment,
  UserShellRecord,
  InboxDelivery,
  InboxState,
  PermissionMode,
  PermissionOption,
  PlanAccountRef,
  RunEvent,
  RunEventPayload,
  RunReport,
  RunState,
  RunStatus,
  OpaqueEvent,
  SessionEvent,
  ContextChargePurpose,
  GoverningEnforcement,
  GoverningFactView,
  GoverningKind,
  MemoryEvidence,
  MemoryKind,
  MemoryOrigin,
  MemoryRecord,
  MemoryScope,
  MemoryState,
  MemoryStatus,
  ReflectionDrop,
  ReportPage, RunCallView,
  RunFactsView,
  ReflectionJobState,
  StopReason,
  ToolKind,
  RunUsage,
  Admission,
  AdmissionAsk,
  TreeSpend,
} from '@momonga/protocol';

export type SessionMcpServers = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export type Session = {
  id: string;
  cwd: string;
  env: Record<string, string>;
  permissionMode: Stored<PermissionMode>;
  model: string;
  bypassAllowed: boolean;
  sandboxNetwork: SandboxNetworkSetting | null;
  additionalDirectories: readonly string[];
  mcpServers: SessionMcpServers;
  createdAt: number;
};

export type SessionPageRequest = { cwd?: string; limit: number; cursor: string | null };

export type ListedSession = Session & { activeRunId: string | null; activeRunAt: number | null; latestRunId: string | null; latestRunAt: number | null };

export type SessionPage = { sessions: ListedSession[]; next: string | null };

export type CreateSessionInput = {
  cwd: string;
  env: Record<string, string>;
  permissionMode: PermissionMode;
  model: string;
  bypassAllowed?: boolean;
  sandboxNetwork?: SandboxNetworkSetting;
  additionalDirectories?: readonly string[];
  mcpServers?: SessionMcpServers;
};

export type RunError = { code: string; message: string; plan?: PlanAccountRef };

export type HistoryMode = 'inherit' | 'fresh';

export type CancelOrigin = (typeof CANCEL_ORIGINS)[number];

export type Run = {
  id: string;
  sessionId: string;
  ordinal: number;
  status: Stored<RunStatus>;
  stopReason?: Stored<StopReason>;
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
  usage: RunUsage;
  previousRunId: string | null;
  history: Stored<HistoryMode>;
  parentRunId: string | null;
  parentCallId: string | null;
  origin: Stored<MemoryOrigin>;
  cancelOrigin: Stored<CancelOrigin> | null;
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
  attachments?: MessageAttachment[];
  mandate?: Mandate;
};

export type UserShellStore = {
  record(sessionId: string, record: UserShellRecord): { kind: 'recorded' } | NotFound;
  pending(sessionId: string): UserShellRecord[];
  runActive(sessionId: string): boolean;
};

export type InboxRow = {
  id: string;
  sessionId: string;
  delivery: Stored<InboxDelivery>;
  text: string;
  images?: ImageAttachment[];
  seq: number;
  state: Stored<InboxState>;
  createdAt: number;
  settledAt: number | null;
  queued: { terms: QueuedRunTerms; origin: Stored<MemoryOrigin> } | null;
};

export type QueuedRunTerms = { timeoutMs: number; limits: Record<string, unknown>; pins: Record<string, unknown>; mandate?: Mandate };

export type InboxAddInput = { delivery: InboxDelivery; text: string; images?: ImageAttachment[]; run: QueuedRunTerms };

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

export type InboxAddResult = { kind: 'added'; row: InboxRow; pending: InboxRow[] } | NotFound | { kind: 'full' };
export type InboxWithdrawResult = { kind: 'withdrawn' | 'already_delivered'; row: InboxRow; pending: InboxRow[] } | NotFound;
export type InboxDeliverResult = { kind: 'ok'; delivered: InboxRow[] } | LeaseLost;

export type InboxStore = {
  add(sessionId: string, input: InboxAddInput): Promise<InboxAddResult>;
  withdraw(id: string): InboxWithdrawResult;
  list(sessionId: string): InboxRow[];
  deliverSteering(claim: Claim): InboxDeliverResult;
  successorOf(runId: string): Run | undefined;
};

export type CreateRunResult = { kind: 'created' | 'existing'; run: Run } | NotFound | { kind: 'key_reused' };
export type RequestCancelResult = { kind: 'ok'; run: Run; changed: boolean } | { kind: 'status_unknown'; run: Run } | NotFound;
export type SetPermissionModeResult = { kind: 'ok'; session: Session; changed: boolean } | NotFound;

export type SetModelResult = { kind: 'ok'; session: Session; changed: boolean } | NotFound;
export type SetSessionMcpServersResult = { kind: 'ok'; session: Session } | NotFound;
export type ResolveApprovalResult =
  | { kind: 'ok'; approval: Approval; run: Run }
  | NotFound
  | { kind: 'approval_not_pending'; status: Approval['status'] }
  | { kind: 'request_missing' }
  | { kind: 'run_cancelled' }
  | { kind: 'option_not_offered' };

export type ModelCallRecord =
  | { kind: 'requested'; seq: number; step: number; attempt: number; anatomy?: TokenAnatomy; prefix?: RunTracePrefix }
  | { kind: 'responded'; seq: number; step: number; attempt: number; responseId?: string; timing?: CallTiming };

export type StartedCall = { callId: string; name: string; idemKey: string };

export type MeterKey = { counter: string; contextWindow: number; tokenErrorRatio?: number; tokenCounting: 'exact' | 'calibrated' | 'estimated' };

export type MeterRecord = {
  runId: string;
  seq: number;
  event: Extract<RunEventPayload, { type: 'meter.observed' }>;
  misses: { miss: number; uncounted: number }[];
};

export type HeartbeatResult = { kind: 'ok'; cancelRequested: boolean; status: ClaimStatus } | LeaseLost;
export type AppendResult = { kind: 'ok'; lastSeq: number } | LeaseLost;
export type RunMutationResult = { kind: 'ok'; run: Run } | LeaseLost | Conflict;
export type ServiceMutationResult = { kind: 'ok'; run: Run } | Conflict;
export type RequestApprovalResult = { kind: 'ok'; approval: Approval } | LeaseLost;
export type InheritContextResult = { kind: 'inherited' } | { kind: 'already' } | { kind: 'none' } | LeaseLost | Conflict;

export type StatusPatch = { stopReason?: StopReason; error?: RunError };


export type IdempotencyRecord = {
  key: string;
  state: 'PENDING' | 'UNKNOWN';
  meta: Record<string, unknown>;
  pgid?: number;
  startedAt?: number;
  leaseToken?: number;
  authorisedAt?: number;
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

export type SettledRun = { runId: string; settled: true };

export type LeasedBegin = IdempotencyBegin | { s: 'LEASE_LOST' };

export type LeasedOutcome = { kind: 'ok' } | LeaseLost;

export type LeasedIdempotency = {
  begin(key: string, options: { expiresAt: number; meta: Record<string, unknown> }): LeasedBegin;
  authorise(key: string, purpose?: 'reconcile'): LeasedOutcome;
  attachProcess(key: string, process: { pgid: number; startedAt: number }): LeasedOutcome;
  checkpoint(key: string, state: Record<string, unknown> | undefined): LeasedOutcome;
  complete(key: string, result: unknown, meta?: Record<string, unknown>): LeasedOutcome;
};

export type IdempotencyStore = {
  get(key: string): IdempotencyLookup | undefined;
  processGroupOf(key: string): number | undefined;
  holding(fence: LeaseFence): LeasedIdempotency;
  clearCheckpoint(key: string): void;
  begin(key: string, options: { expiresAt: number; meta: Record<string, unknown> }): IdempotencyBegin;
  attachProcess(key: string, process: { pgid: number; startedAt: number }): void;
  complete(key: string, result: unknown): void;
  markUnknown(key: string): void;
  markUnknownIfPending(key: string): boolean;
  purgeExpired(nowMs: number): number;
};

type ApprovalRecord = {
  id: string;
  runId: string;
  callId: string;
  status: Stored<'pending' | 'resolved' | 'superseded' | 'expired' | 'withdrawn'>;
  options: PermissionOption[];
  server?: string;
  requests?: ElicitationRequestView[];
  responses?: Record<string, ElicitationAnswerRecord>;
  createdAt: number;
  optionId?: string;
  resolvedAt?: number;
  subjectDigest?: string;
};

export type Approval =
  | (ApprovalRecord & { kind: 'permission' | 'unknown_effect' })
  | (ApprovalRecord & { kind: 'elicitation'; expiresAt: number })
  | (ApprovalRecord & { kind: typeof UNKNOWN_VALUE; expiresAt?: number });

export type ApprovalView = {
  id: string;
  kind: 'permission' | 'unknown_effect';
  runId: string;
  callId: string;
  status: Approval['status'];
  options: PermissionOption[];
  createdAt: number;
  suggestedRule?: string;
  reason: string;
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
  prepare(): Promise<void>;
  handleFor(content: string): string;
  put(data: string | Uint8Array, options: { mediaType: string; runId?: string }): Promise<BlobRef>;
  read(handle: string, range: BlobLineRange, scope?: BlobScope): Promise<BlobSlice>;
  read(handle: string, range: BlobByteRange, scope?: BlobScope): Promise<BlobByteSlice>;
};

export type BlobScope = { runId: string };

export type TrustDecision = 'trusted' | 'untrusted';

export type StoredTrustDecision = Stored<TrustDecision>;

export type TrustAnswer = { decision: StoredTrustDecision | null; inheritedFrom?: string };

export type TrustStore = {
  decisionAsked(path: string, signal: AbortSignal): Promise<TrustAnswer>;
  setAsked(path: string, decision: TrustDecision, signal: AbortSignal): Promise<void>;
  clearAsked(path: string, signal: AbortSignal): Promise<void>;
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

export type AddMemoryByCommandInput = {
  scope: MemoryScope;
  project: string | null;
  text: string;
  kind?: MemoryKind;
  evidence: readonly MemoryEvidence[];
};

export type MemoryVisibility ={ trusted: true; project: string } | { trusted: false };

export type MemoryInclude = 'live' | 'all';

export type SaveCandidateInput = {
  scope: MemoryScope;
  origin: MemoryOrigin;
  project: string | null;
  text: string;
  runId: string;
  ordinal: number;
  kind: MemoryKind;
  evidence: readonly MemoryEvidence[];
};

export type MemoryChange<Done extends string, Refused extends string> =
  | { kind: Done; memory: MemoryRecord }
  | { kind: Refused; memory: MemoryRecord }
  | { kind: 'not_found'; memory?: undefined };

export type RecallCursor = { part: 'matched' | 'rest'; tier: number; contributed: number; kept: number; id: string };

export type RecallPage = { memories: MemoryRecord[]; next: RecallCursor | null; matchCapped: boolean };

export type MemoryListFilter = { scope?: MemoryScope; project?: string; state?: MemoryState };

export type MemoryListCursor = { createdAt: number; id: string };

export type MemoryObservation = { status: Stored<MemoryStatus>; observedAt: number };

export type SessionTouched = { path: string; firstEventId: number };

export type SessionTouchedStore = {
  after(sessionId: string, afterEventId: number, limit: number, afterPath?: string): Promise<SessionTouched[]>;
  newest(sessionId: string, limit: number): Promise<SessionTouched[]>;
};

export type RuntimeMemoryStore = Omit<MemoryStore, 'save'> & {
  save(input: SaveMemoryInput): Promise<{ memory: MemoryRecord; created: boolean }>;
};

export type MemoryStore = {
  save(input: SaveMemoryInput): { memory: MemoryRecord; created: boolean };
  addByCommand(input: AddMemoryByCommandInput): MemoryRecord;
  saveCandidate(input: SaveCandidateInput): { memory: MemoryRecord; created: boolean };
  candidates(filter?: { project?: string }): MemoryRecord[];
  revision(): number;
  supersededIds(): Set<string>;
  activePage(after: { createdAt: number; id: string } | null, limit: number): MemoryRecord[];
  accept(id: string): MemoryChange<'accepted', 'not_candidate'>;
  reject(id: string): MemoryChange<'rejected', 'not_candidate'>;
  markDuplicate(id: string, of: string): MemoryChange<'marked', 'not_active'>;
  archive(id: string): MemoryChange<'archived', 'not_active'>;
  restore(id: string): MemoryChange<'restored', 'not_archived'>;
  get(id: string): MemoryRecord | undefined;
  list(filter?: { scope?: MemoryScope; project?: string }): MemoryRecord[];
  listPage(filter: MemoryListFilter, after: MemoryListCursor | null, limit: number): { memories: MemoryRecord[]; next: MemoryListCursor | null };
  recallPage(visibility: MemoryVisibility, request: { terms: readonly string[]; after: RecallCursor | null; limit: number; through?: number }): RecallPage;
  watermark(): number;
  search(visibility: MemoryVisibility, terms: readonly string[], options?: { include?: MemoryInclude; limit?: number }): MemoryRecord[];
  matchingIds(visibility: MemoryVisibility, terms: readonly string[]): Set<string>;
  retire(id: string): { retired: boolean; memory: MemoryRecord } | undefined;
  history(id: string): MemoryRecord[];
  observe(id: string, status: MemoryStatus): boolean;
  observations(id: string): MemoryObservation[];
  stampContributed(ids: readonly string[], at: number): void;
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

export type GoverningAdmission = { ok: true } | { ok: false; message: string };

export type GoverningAdmissionResult = { kind: 'added'; fact: GoverningFactView; created: boolean } | { kind: 'refused'; message: string };

export type GoverningFactStore = {
  add(input: AddGoverningFactInput): { fact: GoverningFactView; created: boolean };
  addAdmitted(input: AddGoverningFactInput, admit: (existing: readonly GoverningFactView[]) => GoverningAdmission): GoverningAdmissionResult;
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
  origin: Stored<MemoryOrigin>;
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
  readDenied?: (path: string, project: string) => boolean | Promise<boolean>;
};

export type HistorySession = { sessionId: string; project: string; span: { from: number; to: number }; runs: HistoryAnchor[] };

export type HistoryQueryResult = { sessions: HistorySession[]; searched?: number; withheld?: number };

export type HistoryReadRequest = {
  runId: string;
  step?: number;
  seqFrom?: number;
  seqTo?: number;
  limit: number;
  redactor: Redactor;
};

export type HistoryReadResult =
  | { kind: 'ok'; runId: string; project: string; origin: Stored<MemoryOrigin>; events: RunEvent[]; callPaths: Record<string, string[]>; nextSeq: number | null }
  | { kind: 'not_visible' };

export type FactsCursor = { definitionsVersion: number; afterEventId: number };

export type FactsBatch = { runIds: string[]; throughEventId: number };

export type FactsCommit = { rows: readonly RunFactsView[]; calls: readonly RunCallView[]; unavailable: readonly string[]; throughEventId: number };

export type StoredFacts = { kind: 'facts'; facts: RunFactsView } | { kind: 'unavailable' };

export type RunFactsStore = {
  cursor(): FactsCursor;
  nextBatch(limit: number): FactsBatch;
  commit(batch: FactsCommit): void;
  get(runId: string): StoredFacts | undefined;
  page(after: string, limit: number): ReportPage;
  calls(after: { runId: string; callId: string } | null, limit: number): RunCallView[];
};

export type SearchStore = {
  indexBatch(options: { limit: number; redactor: Redactor; maxChars?: number }): Promise<{ runs: number }>;
  visibleProjects(visibility: HistoryVisibility, scope: HistoryScope): string[];
  query(visibility: HistoryVisibility, request: HistoryQueryRequest): Promise<HistoryQueryResult>;
  readRange(visibility: HistoryVisibility, request: HistoryReadRequest): Promise<HistoryReadResult>;
  projectOf(visibility: HistoryVisibility, runId: string): string | undefined;
};

export type ReflectionJob = {
  runId: string;
  state: Stored<ReflectionJobState>;
  attempts: number;
  lastError: string | null;
  dropped: ReflectionDrop[];
  createdAt: number;
  updatedAt: number;
};

export type ContextChargeInput = {
  purpose: ContextChargePurpose;
  runId: string | null;
  project: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  detail?: BilledDetail;
};

export type ReflectionCompletion = {
  runId: string;
  charge: ContextChargeInput | null;
  candidates: readonly SaveCandidateInput[];
  dropped?: readonly ReflectionDrop[];
  reason?: string;
};

export type ReflectionStore = {
  runOrigin(runId: string): Stored<MemoryOrigin> | undefined;
  enqueue(runId: string): boolean;
  get(runId: string): ReflectionJob | undefined;
  latestForProject(project: string): ReflectionJob | undefined;
  aheadOf(runId: string): number;
  next(exclude?: ReadonlySet<string>): ReflectionJob | undefined;
  begin(runId: string): ReflectionJob;
  release(runId: string): ReflectionJob;
  finish(runId: string, reason?: string): ReflectionJob;
  complete(completion: ReflectionCompletion): ReflectionJob;
  fail(runId: string, reason: string, charge?: ContextChargeInput, candidates?: readonly SaveCandidateInput[]): ReflectionJob;
};

export type ContextCharge = Omit<ContextChargeInput, 'purpose'> & { purpose: Stored<ContextChargePurpose>; id: number; createdAt: number };

export type ContextChargeStore = {
  record(input: ContextChargeInput): ContextCharge;
  list(filter?: { runIds?: readonly string[]; project?: string }): ContextCharge[];
};

export type Guideline = {
  version: number;
  text: string;
  parent: number | null;
  createdAt: number;
  adoptedAt: number;
  report: Readonly<Record<string, unknown>>;
};

export type GuidelineStore = {
  current(): Guideline | undefined;
  get(version: number): Guideline | undefined;
  list(): Guideline[];
  adopt(input: { text: string; parent: number | null; report: Guideline['report'] }): Guideline;
  rollback(version: number): Guideline;
};

export type RuntimeStore = {
  createSession(input: CreateSessionInput): Session;
  getSession(id: string): Session | undefined;
  getListedSession(id: string): ListedSession | undefined;
  listSessions(request: SessionPageRequest): SessionPage;
  createRunAndEnqueue(sessionId: string, input: CreateRunInput): Promise<CreateRunResult>;
  findRunByIdempotencyKey(sessionId: string, key: string): { run: Run; requestDigest: string | null } | undefined;
  sessionActivity(sessionId: string): { lastActivityAt: number; hasActiveRun: boolean } | undefined;
  checkIdentity(): Promise<void>;
  pruneFidelityVerdicts(bound: number): number;
  readonly maxTotalAttempts: number;
  getRun(id: string): Run | undefined;
  claim(workerId: string): Claim | null;
  heartbeat(claim: Claim): HeartbeatResult;
  append(claim: Claim, events: readonly RunEventPayload[]): AppendResult;
  transition(claim: Claim, from: readonly RunStatus[], to: RunStatus, patch?: StatusPatch, preceding?: readonly RunEventPayload[]): Promise<RunMutationResult>;
  release(claim: Claim, to: RunStatus, availableAt?: number, options?: { refundAttempt?: boolean; awaits?: WaitTargets }): Promise<RunMutationResult>;
  releaseLease(claim: Claim, options: { availableAt: number; refundAttempt?: boolean }): Promise<RunMutationResult>;
  requestCancel(runId: string): Promise<RequestCancelResult>;
  setPermissionMode(sessionId: string, mode: PermissionMode): SetPermissionModeResult;
  setModel(sessionId: string, model: string): SetModelResult;
  setSessionMcpServers(sessionId: string, servers: SessionMcpServers): SetSessionMcpServersResult;
  listRuns(sessionId: string, statuses?: readonly RunStatus[]): Run[];
  appendAsService(
    runId: string,
    expectedVersion: number,
    to: RunStatus | null,
    events: readonly RunEventPayload[],
    patch?: StatusPatch,
  ): Promise<ServiceMutationResult>;
  readRunEvents(runId: string, afterSeq: number, limit: number): RunEvent[];
  readRunEventsOfTypes(runId: string, types: readonly RunEventPayload['type'][], afterSeq?: number): RunEvent[];
  latestSessionNotice(sessionId: string, code: string, key: string): RunEvent | undefined;
  readLatestRunEventBefore<T extends RunEventPayload['type']>(runId: string, type: T, beforeSeq: number): Extract<RunEvent, { type: T }> | undefined;
  readModelCallEvents(runId: string): Promise<ModelCallRecord[]>;
  toolCallSeq(runId: string, callId: string): Promise<number | undefined>;
  finalTextOf(runId: string): Promise<string>;
  inFlightModelRequestOf(runId: string): Promise<{ step: number; attempt: number } | undefined>;
  startedCallsOf(runId: string): Promise<StartedCall[]>;
  hasNoticeCode(runId: string, code: string): Promise<boolean>;
  meterRecordOf(sessionId: string, key: MeterKey): Promise<MeterRecord | undefined>;
  answeringTargetsOf(runId: string): Promise<string[]>;
  recordFidelityVerdicts(runId: string, cwd: string, reply: Pick<FidelityReply, 'checkedThrough' | 'verdicts'>): void;
  lastTerminalRootRuns(project: string, limit: number): Run[];
  toolCallNames(rootRunId: string): Promise<string[]>;
  toolOfferedNames(rootRunId: string): string[];
  readSessionEvents(sessionId: string, afterId: number, limit: number): (RunEvent | SessionEvent)[];
  readRunEventStream(runId: string, afterSeq: number, limit: number): (RunEvent | SessionEvent | OpaqueEvent)[];
  readSessionEventStream(sessionId: string, afterId: number, limit: number): (RunEvent | SessionEvent | OpaqueEvent)[];
  readModelChanges(sessionId: string, afterId: number): Extract<SessionEvent, { type: 'model.changed' }>[];
  sessionMaxEventId(sessionId: string): number;
  load(runId: string, signal: AbortSignal): Promise<RunStateReply>;
  requestApproval(
    claim: Claim,
    input: {
      callId: string;
      options: PermissionOption[];
      event: { subjectDigest: string; reason: string; suggestedRule?: string };
      held?: { footprint: CallFootprint; placeholder?(approvalId: string): string };
    },
  ): Promise<RequestApprovalResult>;
  requestUnknownAck(claim: Claim, input: { callIds: string[] }): Promise<RequestApprovalResult>;
  resolveApproval(approvalId: string, optionId: string): Promise<ResolveApprovalResult>;
  requestElicitation(
    claim: Claim,
    input: { callId: string; expiresAt: number; server: string; requests: ElicitationRequestView[] },
  ): Promise<RequestApprovalResult>;
  resolveElicitation(elicitationId: string, responses: Record<string, ElicitationAnswerRecord>, notices?: readonly string[]): Promise<ResolveElicitationResult>;
  elicitationView(elicitationId: string): Promise<ElicitationView | undefined>;
  pendingElicitationViews(runId: string): Promise<ElicitationView[]>;
  expireApprovals(nowMs: number, onError: SweepErrorSink): Promise<string[]>;
  finishCancelled(onError: SweepErrorSink): Promise<string[]>;
  deadLetterExhausted(onError: SweepErrorSink): Promise<string[]>;
  terminalRunIdsWithCheckpoint(): string[];
  hasActiveRun(): boolean;
  approvalView(approvalId: string): Promise<ApprovalView | undefined>;
  pendingApprovalViews(runId: string): Promise<ApprovalView[]>;
  inheritContext(claim: Claim, options: { mode: PermissionMode; facts?: Pick<JournalFacts, 'inheritPlan'> }): Promise<InheritContextResult>;
  dataVersion(): number;
  createChildRun(input: ChildRunInput): Promise<CreateChildRunResult>;
  listChildRuns(runId: string): Run[];
  treeSpend(runId: string): TreeSpend & { runsRead: number };
  admitModelRequest(holder: LeaseFence | SettledRun, ask: AdmissionAsk): Admission | LeaseLost;
  releaseBudget(runId: string): void;
  rootSessionId(sessionId: string): string;
  jobs: JobStore;
  idempotency: IdempotencyStore;
  approvals: ApprovalStore;
  blobs: BlobStore;
  trust: TrustStore;
  ruleVerdicts: RuleVerdictStore;
  inbox: InboxStore;
  userShell: UserShellStore;
  memories: RuntimeMemoryStore;
  sessionTouched: SessionTouchedStore;
  reflection: ReflectionStore;
  contextCharges: ContextChargeStore;
  guidelines: GuidelineStore;
  governing: GoverningFactStore;
  search: SearchStore;
  runFacts: RunFactsStore;
  permissionReviews: PermissionReviewsStore;
  readonly journalFacts: JournalFacts;
  close(): void;
};

export type RuntimeStoreOptions = {
  path: string;
  home: string;
  lock: KernelLockMechanism;
  busyTimeoutMs: number;
  clock: Clock;
  fileSystem: FileSystem;
  random: Random;
  leaseMs: number;
  maxAttempts: number;
  maxTotalAttempts: number;
  generation?: number;
  onCommit?: (touched: { runId?: string; sessionId: string }[]) => void;
  preparer?: ContributionPreparer;
  unaskedCommands: UnaskedCommands;
  onDecode?: (rows: number, bytes: number) => void;
  onEncode?: (kind: string, bytes: number) => void;
};

export type SweepErrorSink = (error: unknown, runId: string) => void;

export type ContributionRequest = { runId: string; leading: readonly RunEventPayload[] };

export type ContributionMeasured = { lastSeq: number; contribution?: ContributionPayload };

export type VerdictRequest = { runId: string; commands: readonly string[]; manifests: readonly string[] };

export type VerdictFact = {
  command: string;
  text: string;
  kind: 'procedure';
  check: { conditionId: string; seq: number };
  manifestPaths: string[];
};

export type VerdictReply = { lastSeq: number; verified: boolean; facts: VerdictFact[] };

export type EvidenceRequest = { runId: string; paths: readonly string[]; onlyCommand?: string };

export type RecordedHash = { sha256: string; seq: number };

export type RecordedCheck = { conditionId: string; seq: number; command: string; exitCode: number };

export type EvidenceReply = { lastSeq: number; recorded: (RecordedHash | null)[]; check: RecordedCheck | null };

export type ReflectionInputRequest = { runId: string; project: string; capabilities: Capabilities };

export type ReflectionInputReply = { lastSeq: number; input: string };

export type FidelityRequest = { runId: string; throughEventSeq: number; cwd: string; tokens: readonly ClaimedToken[] };

export const VERDICT_RANKS = ['none', 'stated', 'executed'] as const;

export type VerdictRank = (typeof VERDICT_RANKS)[number];

export type FidelityVerdict = {
  token: string;
  inh: VerdictRank;
  inhDeps: string[];
  taskStated: boolean;
  statedAt: number | null;
  executedAt: number | null;
  ownDeps: string[];
};

export type FidelityVerdictRow = FidelityVerdict & { checkedThrough: number };

export type FidelityReply = {
  lastSeq: number;
  attested: string[];
  unreadable: { handle: string; reason: string }[];
  checkedThrough: number;
  verdicts: FidelityVerdict[];
};

export type ReportRequest = { runId: string };

export type ReportReply = { lastSeq: number; report: RunReport };

export type RunStateRequest = { runId: string };

export type RunStateReply = { lastSeq: number; state: RunState };

export type JournalFacts = {
  inheritPlan(request: InheritPlanRequest, signal?: AbortSignal): Promise<InheritPlanReply>;
  inheritedWindow(request: InheritedWindowRequest, signal?: AbortSignal): Promise<InheritedWindowReply>;
  verdict(request: VerdictRequest, signal?: AbortSignal): Promise<VerdictReply>;
  evidence(request: EvidenceRequest, signal?: AbortSignal): Promise<EvidenceReply>;
  reflectionInput(request: ReflectionInputRequest, signal?: AbortSignal): Promise<ReflectionInputReply>;
  fidelity(request: FidelityRequest, signal?: AbortSignal): Promise<FidelityReply>;
  report(request: ReportRequest, signal?: AbortSignal): Promise<ReportReply>;
  runState(request: RunStateRequest, signal?: AbortSignal): Promise<RunStateReply>;
};

export type ContributionPreparer = JournalFacts & {
  measure(request: ContributionRequest, signal?: AbortSignal): Promise<ContributionMeasured>;
};

export type ContributionPayload = Extract<RunEventPayload, { type: 'context.contribution' }>;

export type TerminalContribution = {
  eventTypes: readonly RunEventPayload['type'][];
  measure(input: {
    run: Run;
    events: readonly RunEvent[];
    replay(visit: (state: RunState, event: RunEvent) => void): void;
    memories: Pick<MemoryStore, 'get'>;
    governing: Pick<GoverningFactStore, 'get'>;
    unit?: () => void;
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
  ownerGeneration?: number;
  killRequestedAt?: number;
  outputPath?: string;
};

export type StartJobInput = { id: string; idemKey: string; sessionId: string; runId: string; callId: string; command: string; ownerGeneration?: number; outputPath?: string };

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
  requestKill(id: string): boolean;
  clearOutputPath(id: string): void;
};

export type ChildRunInput = {
  parentRunId: string;
  parentCallId: string;
  input: string;
  pins: Record<string, unknown>;
  model: string;
};

export type CreateChildRunResult =
  | { kind: 'created' | 'existing'; run: Run; session: Session }
  | { kind: 'parent_not_active'; status: Stored<RunStatus> | 'missing' };

export type WaitTargets = { runIds: readonly string[]; jobIds: readonly string[] };
