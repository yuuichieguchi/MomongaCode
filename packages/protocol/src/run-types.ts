import type { ContributionKind, SummaryFidelity, SummarySource } from './context-record.ts';
import type { VerificationOutcome, VerificationState } from './completion.ts';
import type { ToolFile, WorkingFacts } from './working-facts.ts';
import type { HookExecution, HookStart } from './hooks.ts';
import type { PrefixEvent } from './prefix-events.ts';
import type { MemoryStatus } from './memory.ts';
import type { Stored } from './stored-value.ts';
import type { CompactionInputItem, InputItem, MessageInputItem } from './open-responses.ts';
import type { ApprovalBasis, PermissionDenial } from './permission-denial.ts';
import type { BudgetExhausted, CallFootprint, HeldCallView, HeldOutcome, RequestBudget, RunUsage } from './budget.ts';
import type { CallTiming, ModelCost, TokenAnatomy, UnpricedOutcome } from './token-anatomy.ts';

export const RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'WAITING_TOOL',
  'WAITING_HUMAN',
  'CANCELLING',
  'COMPLETED',
  'STOPPED',
  'FAILED',
  'CANCELLED',
] as const;

export const TERMINAL_STATUSES = ['COMPLETED', 'STOPPED', 'FAILED', 'CANCELLED'] as const;

export const STOP_REASONS = ['max_steps', 'budget', 'max_tokens', 'timeout', 'loop', 'approval_timeout', 'refusal', 'usage_limit', 'conditions_unmet'] as const;

export const PERMISSION_MODES = ['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const;

export const PERMISSION_MODE_DESCRIPTIONS: Readonly<Record<(typeof PERMISSION_MODES)[number], string>> = {
  manual: 'asks before every file change and command',
  acceptEdits: 'accepts file edits inside the workspace, asks before commands',
  plan: 'read-only tools, the agent proposes a plan',
  auto: 'an automatic classifier decides which calls are allowed',
  bypassPermissions: 'runs every tool without asking',
};

export const APPROVAL_STATUSES = ['pending', 'resolved', 'superseded', 'expired', 'withdrawn'] as const;

export const TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type StopReason = (typeof STOP_REASONS)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const OPERATION_EFFECT_OUTCOMES = ['applied', 'already_applied', 'failed', 'unknown'] as const;

export type OperationEffectRecord = { operation: string; target: string; outcome: (typeof OPERATION_EFFECT_OUTCOMES)[number] };

export const APPROVAL_KINDS = ['permission', 'elicitation', 'unknown_effect'] as const;

export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const unknownEffectOptions = (): PermissionOption[] => [{ optionId: 'allow_once', name: 'Continue', kind: 'allow_once' }];

export const UNKNOWN_EFFECT_REASON = 'Its effect is unknown because the runtime stopped while it ran.';

export const UNKNOWN_EFFECT_ADVICE = 'Inspect the current state, then continue. To stop instead, cancel the run.';

export type UnknownEffectCall = { title: string; found?: string };

export const unknownEffectTitle = (calls: readonly UnknownEffectCall[]): string => {
  const [first, ...others] = calls;
  if (first === undefined) throw new Error('an unknown effect names at least one call');
  return `Effect unknown: ${first.title}${others.length === 0 ? '' : ` and ${others.length} more`}`;
};

export const unknownEffectLines = (calls: readonly UnknownEffectCall[]): string[] => [
  ...calls.flatMap((call) => [
    `${call.title}: ${UNKNOWN_EFFECT_REASON}`,
    ...(call.found === undefined ? [] : [`What the recovery found: ${call.found}`]),
  ]),
  UNKNOWN_EFFECT_ADVICE,
];
export type ToolKind = (typeof TOOL_KINDS)[number];

export const SIDE_EFFECTS = ['read_only', 'write', 'exec'] as const;

export type SideEffect = (typeof SIDE_EFFECTS)[number];

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export type ImageAttachment = { mediaType: ImageMediaType; data: string };

export type AttachedFilePart = { type: 'attached_file'; path: string; content: string; truncated: false };

export type AttachmentNotePart = { type: 'attachment_note'; path: string; text: string; shown: string };

export type MessageAttachment = AttachedFilePart | AttachmentNotePart;

export const USER_SHELL_OUTPUT_BYTES = 64 * 1024;
export const USER_SHELL_HEAD_BYTES = 16 * 1024;
export const USER_SHELL_TAIL_BYTES = USER_SHELL_OUTPUT_BYTES - USER_SHELL_HEAD_BYTES;
export const USER_SHELL_COMMAND_CHARS = 100_000;
export const USER_SHELL_RUN_ACTIVE_CODE = 'run_active';
export const PROMPT_TEXT_MAX_CHARS = 1_000_000;
export const NOTHING_TO_COMPACT_CODE = 'nothing_to_compact';
export const NOTHING_TO_COMPACT_MESSAGE = 'Nothing to compact.';

export type UserShellRecord = { command: string; exitCode: number | null; output: string; include: boolean };

export const INBOX_DELIVERIES = ['steer', 'queue'] as const;

export type InboxDelivery = (typeof INBOX_DELIVERIES)[number];

export const INBOX_STATES = ['pending', 'delivered', 'withdrawn'] as const;

export type InboxState = (typeof INBOX_STATES)[number];

export const INBOX_MAX_PENDING = 20;

export const INBOX_FULL_CODE = 'inbox_full';

export const inboxFullMessage = (): string => `${INBOX_MAX_PENDING} messages are already waiting`;

export type InboxRowView = {
  id: string;
  sessionId: string;
  delivery: Stored<InboxDelivery>;
  text: string;
  images?: { mediaType: ImageMediaType; byteLength: number }[];
  seq: number;
  state: Stored<InboxState>;
  createdAt: number;
  settledAt: number | null;
};

export type InboxChangeRow = Pick<InboxRowView, 'id' | 'delivery' | 'state' | 'seq'>;

export type ElicitationRequestView =
  | { key: string; mode: 'form'; message: string; requestedSchema: Record<string, unknown> }
  | { key: string; mode: 'url'; message: string; url: string };

export type ElicitationAnswerRecord =
  | { action: 'accept'; content?: Record<string, string | number | boolean | string[]> }
  | { action: 'decline' }
  | { action: 'cancel' };

export type ModelResponse = {
  id?: string;
  status: 'completed' | 'incomplete';
  incompleteReason?: string;
  output: unknown[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { cached_tokens: number };
    output_tokens_details?: { reasoning_tokens: number };
  };
  momonga?: { cacheWriteInputTokens?: number; cacheReadNotReported?: true; cost?: ModelCost; unpriced?: UnpricedOutcome };
  timing?: CallTiming;
};

export type ActivatedSkillRecord = { name: string; content: string };

export type ActivatedSkillEntry = { name: string; content: string; seq: number };

export const MODEL_REJECTION_REASONS = ['counter_mismatch', 'missing_counter', 'missing_usage', 'missing_target'] as const;

export type ModelRejectionReason = (typeof MODEL_REJECTION_REASONS)[number];

export const USAGE_CHARGE_PURPOSES = ['compaction', 'permission_classifier', 'rejected_answer'] as const;

export type UsageChargePurpose = (typeof USAGE_CHARGE_PURPOSES)[number];

export const JOB_STATUSES = ['running', 'exited', 'killed', 'unknown'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export type DiffHunk = { oldStart: number; newStart: number; lines: string[] };

export type AppliedDiffFields = { hunks?: DiffHunk[]; added?: number; removed?: number; diffOmitted?: string };

export const diffFieldsOf = ({ hunks, added, removed, diffOmitted }: AppliedDiffFields): AppliedDiffFields => ({
  ...(hunks === undefined ? {} : { hunks }),
  ...(added === undefined ? {} : { added }),
  ...(removed === undefined ? {} : { removed }),
  ...(diffOmitted === undefined ? {} : { diffOmitted }),
});

export type HeldLink = { approvalId: string };

export type HeldEnd = { callId: string; approvalId: string; outcome: HeldOutcome; status: 'completed' | 'failed' };

export type ToolAwait = { kind: 'run'; runId: string; sessionId: string; agent: string } | { kind: 'job'; jobId: string };

export type InheritedCopyPayload = {
  type: 'context.inherited';
  form?: undefined;
  fromRunId: string;
  fromLastSeq: number;
  history: { seq: number; item: InputItem; callId?: string; handle?: string }[];
  nextItemSeq: number;
  summary?: { item: CompactionInputItem | MessageInputItem; summary: string; replacedThroughSeq: number };
  workingFacts?: WorkingFacts;
  evicted: string[];
  closures: { callId: string; seq: number; effect: 'not_executed' | 'unknown'; announced: boolean }[];
  partial?: { seq: number };
  markers: { seq: number; kind: 'interrupted' | 'unprocessed' | 'dropped' | 'mode_changed' }[];
  fromMode?: PermissionMode;
  mode?: PermissionMode;
  activatedSkills?: ActivatedSkillRecord[];
  digest: string;
};

export type RunEventPayload =
  | { type: 'user.message'; text: string; images?: ImageAttachment[]; source?: InboxDelivery; attachments?: MessageAttachment[]; shell?: UserShellRecord[] }
  | { type: 'run.started'; attempt: number; now: number; pins: Record<string, unknown>; mode?: PermissionMode }
  | { type: 'attempt.failed'; attempt: number; code: string; retryAt: number; limit: number }
  | { type: 'attempt.lost'; lastLiveAt: number }
  | { type: 'run.status'; from: RunStatus; to: RunStatus; reason?: string }
  | {
      type: 'model.requested';
      step: number;
      attempt: number;
      digest: string;
      pinnedDigest?: string;
      body: unknown;
      anatomy?: TokenAnatomy;
      prefix?: { preservedItems: number; toolsChanged: boolean; causes: PrefixEvent[] };
      budget?: RequestBudget;
    }
  | { type: 'model.responded'; step: number; attempt: number; response: ModelResponse; target?: string }
  | { type: 'agent.message.delta'; step: number; attempt: number; itemId: string; text: string }
  | { type: 'agent.thought.delta'; step: number; attempt: number; itemId: string; text: string }
  | { type: 'model.stream.restarted'; step: number; attempt: number }
  | {
      type: 'tool.call';
      callId: string;
      providerCallId: string;
      name: string;
      kind: ToolKind;
      sideEffect?: SideEffect;
      title: string;
      rawInput: unknown;
      locations?: { path: string; line?: number }[];
    }
  | {
      type: 'tool.permission.requested';
      approvalId: string;
      callId: string;
      options: PermissionOption[];
      subjectDigest: string;
      reason: string;
      suggestedRule?: string;
    }
  | {
      type: 'tool.permission.classified';
      callId: string;
      subjectDigest: string;
      model?: string;
      outcome: 'allow' | 'ask';
      verdict?: 'safe' | 'unsafe';
      confidence?: 'high' | 'medium' | 'low';
      rationale?: string;
      failure?: string;
    }
  | { type: 'tool.permission.classifying'; callId: string; subjectDigest: string }
  | ({ type: 'hook.started' } & HookStart)
  | ({ type: 'hook.completed' } & HookExecution)
  | { type: 'tool.permission.resolved'; approvalId: string; optionId: string; rulePersisted?: boolean }
  | { type: 'tool.permission.cancelled'; approvalId: string; reason: 'expired' | 'withdrawn' | 'superseded' }
  | { type: 'tool.unknown.requested'; approvalId: string; callIds: string[]; options: PermissionOption[]; subjectDigest: string }
  | { type: 'tool.unknown.resolved'; approvalId: string; optionId: string }
  | { type: 'tool.unknown.cancelled'; approvalId: string; reason: 'expired' | 'withdrawn' | 'superseded' }
  | { type: 'tool.elicitation.requested'; inputId: string; callId: string; server: string; requests: ElicitationRequestView[] }
  | { type: 'tool.elicitation.resolved'; inputId: string; responses: Record<string, ElicitationAnswerRecord> }
  | { type: 'tool.elicitation.cancelled'; inputId: string; reason: 'expired' | 'withdrawn' | 'superseded' }
  | { type: 'mcp.authorization.required'; server: string; callId?: string }
  | { type: 'tool.started'; callId: string; idemKey: string; basis?: ApprovalBasis }
  | { type: 'tool.updated'; callId: string; content: unknown[] }
  | ({
      type: 'tool.completed';
      callId: string;
      status: 'completed' | 'failed';
      output: string;
      content?: unknown[];
      truncated?: boolean;
      handle?: string;
      denial?: PermissionDenial;
      files?: ToolFile[];
      mutated?: true;
      command?: string;
      windowShared?: true;
      memories?: string[];
      exitCode?: number;
      formatted?: { formatter: string; version: number };
      effect?: OperationEffectRecord;
      held?: HeldLink;
    } & AppliedDiffFields)
  | { type: 'verification.started'; round: number; conditionId: string; command: string; mutationSeq: number; attempt: number }
  | {
      type: 'verification.completed';
      round: number;
      conditionId: string;
      command: string;
      outcome: VerificationOutcome;
      exitCode?: number;
      durationMs: number;
      output: string;
      truncated?: boolean;
      handle?: string;
      mutationSeq: number;
    }
  | { type: 'tool.loaded'; names: string[] }
  | { type: 'tool.offered'; names: string[] }
  | { type: 'loop.warned'; signature: string }
  | ({ type: 'budget.exhausted' } & BudgetExhausted)
  | { type: 'tool.held'; callId: string; approvalId: string; reason: string; footprint: CallFootprint }
  | { type: 'tool.held.resolved'; callId: string; approvalId: string; outcome: HeldOutcome; status: 'completed' | 'failed'; output: string }
  | { type: 'run.quiescent'; held: HeldCallView[] }
  | {
      type: 'model.rejected';
      step: number;
      attempt: number;
      reason: ModelRejectionReason;
      counter?: string;
      meterCounter?: string;
      target?: string;
    }
  | {
      type: 'meter.observed';
      target: string;
      counter: string;
      fallback: boolean;
      inputDigest: string;
      itemCount: number;
      counted: number;
      reported: number;
      kept: number;
      known: number;
      uncounted: number;
      miss: number;
      contextWindow: number;
      tokenErrorRatio?: number;
      tokenCounting: 'exact' | 'calibrated' | 'estimated';
    }
  | ({ type: 'tool.reconciled'; callId: string; outcome: 'already_applied' | 'not_applied' | 'unknown'; output: string; interrupted?: 'timeout' | 'cancelled'; files?: ToolFile[]; command?: string; effect?: OperationEffectRecord; held?: HeldLink } & AppliedDiffFields)
  | { type: 'tool.waiting'; callId: string; awaits: ToolAwait; wakeAt?: number }
  | { type: 'job.finished'; jobId: string; status: Exclude<JobStatus, 'running'>; exitCode?: number; signal?: string }
  | {
      type: 'plan.updated';
      entries: { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' }[];
    }
  | { type: 'usage.updated'; inputTokens: number; outputTokens: number; totalTokens: number }
  | {
      type: 'usage.charged';
      purpose: UsageChargePurpose;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      responseId?: string;
      cachedInputTokens?: number;
      cacheWriteInputTokens?: number;
      cost?: ModelCost;
      unpriced?: UnpricedOutcome;
      timing?: CallTiming;
      target?: string;
    }
  | {
      type: 'context.compacted';
      item: CompactionInputItem | MessageInputItem;
      summary: string;
      replacedThroughSeq: number;
      source?: SummarySource;
      fidelity?: SummaryFidelity;
      guidelineVersion?: number;
      tokensBefore?: number;
      tokensAfter?: number;
    }
  | { type: 'context.governing_loaded'; active: { id: string; textSha256: string }[]; conflicts: { target: string; ids: string[] }[] }
  | { type: 'context.memories_loaded'; memories: { id: string; status: MemoryStatus }[] }
  | { type: 'context.contribution'; items: { kind: ContributionKind; id: string; contributed: boolean }[] }
  | { type: 'context.compacting'; step: number; attempt: number }
  | { type: 'context.compaction_rejected'; step?: number; attempt?: number; item: MessageInputItem }
  | InheritedCopyPayload
  | InheritedReferencePayload
  | { type: 'context.truncated'; callId: string; handle: string; kind: 'omitted' | 'truncated' | 'reference'; keptChars?: number; tokens?: number }
  | { type: 'instructions.loaded'; path: string; content: string }
  | { type: 'skill.activated'; name: string; content: string }
  | { type: 'approval.rule.persisted'; approvalId: string; effect: 'allow' | 'deny'; rule: string }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string; code?: string; toolKey?: string; reduction?: NoticeReduction };

export type SessionEventPayload =
  | { type: 'mode.changed'; mode: Stored<PermissionMode> }
  | { type: 'model.changed'; model: string; previousModel: string }
  | { type: 'inbox.changed'; pending: InboxChangeRow[] }
  | ({ type: 'user_shell' } & UserShellRecord);

export type SessionEvent = SessionEventPayload & { id: number; sessionId: string; createdAt: number };

export type InheritedSynthesisEntry = { seq: number; item: InputItem; callId?: string };

export type InheritedViaLink = { runId: string; lastSeq: number; nextItemSeq: number; omitSeqs: number[]; synthesised: InheritedSynthesisEntry[] };

export type InheritedReferencePayload = {
  type: 'context.inherited';
  form: 'reference';
  fromRunId: string;
  fromLastSeq: number;
  nextItemSeq: number;
  fromNextItemSeq: number;
  compaction?: { runId: string; eventSeq: number };
  omitSeqs: number[];
  synthesised: InheritedSynthesisEntry[];
  via: InheritedViaLink[];
  itemCount: number;
  workingFacts?: WorkingFacts;
  closures: { callId: string; seq: number; effect: 'not_executed' | 'unknown'; announced: boolean }[];
  partial?: { seq: number };
  markers: { seq: number; kind: 'interrupted' | 'unprocessed' | 'dropped' | 'mode_changed' }[];
  fromMode?: PermissionMode;
  mode?: PermissionMode;
  activatedSkills?: ActivatedSkillRecord[];
  digest: string;
};

export const isInheritedReference = (payload: InheritedCopyPayload | InheritedReferencePayload): payload is InheritedReferencePayload => payload.form === 'reference';

export type RunEventEnvelope = {
  id: number;
  runId: string;
  sessionId: string;
  seq: number;
  step: number;
  leaseToken: number;
  createdAt: number;
};

export type RunEvent = RunEventPayload extends infer Payload ? (Payload extends unknown ? Payload & RunEventEnvelope : never) : never;

type HoldEndingPayload = Extract<RunEventPayload, { type: 'tool.completed' | 'tool.reconciled' | 'tool.held.resolved' }>;

const isHoldEnding = (event: { type: string }): event is HoldEndingPayload =>
  event.type === 'tool.completed' || event.type === 'tool.reconciled' || event.type === 'tool.held.resolved';

export const heldEndOf = (event: { type: string }): HeldEnd | undefined => {
  if (!isHoldEnding(event)) return undefined;
  if (event.type === 'tool.held.resolved') return { callId: event.callId, approvalId: event.approvalId, outcome: event.outcome, status: event.status };
  if (event.held === undefined) return undefined;
  const status = event.type === 'tool.completed' ? event.status : event.outcome === 'already_applied' ? 'completed' : 'failed';
  return { callId: event.callId, approvalId: event.held.approvalId, outcome: 'executed', status };
};

export type HeldCall = {
  name: string;
  providerCallId: string;
  arguments: unknown;
  step: number;
  approvalId: string;
  reason: string;
  sinceSeq: number;
  footprint: CallFootprint;
  subjectDigest?: string;
  options?: PermissionOption[];
  resolution?: { optionId: string; kind: PermissionOption['kind']; subjectDigest: string };
  cancelled?: 'expired' | 'withdrawn' | 'superseded';
};

export type PendingCallStatus = 'requested' | 'awaiting_approval' | 'awaiting_input' | 'started' | 'completed' | 'reconciled';

export type NoticeReduction = { turn: number; from: number; to: number };

export type RunState = {
  runId: string;
  sessionId: string;
  status: RunStatus;
  stopReason?: StopReason;
  step: number;
  attempt: number;
  usage: RunUsage;
  heldCalls?: Record<string, HeldCall>;
  quiescent?: true;
  history: { seq: number; item: InputItem; callId?: string; handle?: string; omittedTokens?: number }[];
  nextItemSeq: number;
  summary?: { item: CompactionInputItem | MessageInputItem; summary: string; replacedThroughSeq: number };
  workingFacts: WorkingFacts;
  evicted: string[];
  pins?: Record<string, unknown>;
  pendingCalls: Record<
    string,
    {
      name: string;
      providerCallId: string;
      arguments: unknown;
      status: PendingCallStatus;
      sideEffect?: SideEffect;
      basis?: ApprovalBasis;
      idemKey?: string;
      awaiting?: ToolAwait;
      approvalId?: string;
      options?: PermissionOption[];
      subjectDigest?: string;
      suggestedRule?: string;
      classification?: { subjectDigest: string; outcome: 'allow' | 'ask' };
      resolution?: { optionId: string; kind: PermissionOption['kind']; subjectDigest: string; suggestedRule?: string; rulePersisted?: true };
      input?: { inputId: string; server: string; requests: ElicitationRequestView[] };
      inputResolution?: { inputId: string; responses: Record<string, ElicitationAnswerRecord> };
    }
  >;
  inFlightModelRequest?: { step: number; attempt: number; digest: string; body: unknown; requestedSeq: number };
  notes: { level: 'info' | 'warning' | 'error'; message: string; code?: string; toolKey?: string; reduction?: NoticeReduction }[];
  toolCallCounts: Record<string, number>;
  steps: Record<number, { toolChoice: string; summary: boolean }>;
  lastResponse?: { step: number; incomplete: boolean; incompleteReason?: string; refusal: boolean; callIds: string[] };
  loadedInstructions: { path: string; textSha256: string; seq: number; content: string }[];
  hookCompletions: Record<string, number>;
  stopHookRanSinceResponse: boolean;
  stopHookContinuations: number;
  compactions: number;
  lastCompactionSeq: number;
  callResults: Record<string, 'completed' | 'failed'>;
  unknownEffects: Record<string, { approvalId?: string; acknowledged: boolean }>;
  lastMutationSeq: number;
  verification: VerificationState;
  formsSinceCompaction: Record<string, number>;
  governingLoaded?: { active: { id: string; textSha256: string }[]; conflicts: { target: string; ids: string[] }[] };
  memoriesLoaded?: { id: string; status: MemoryStatus }[];
  activatedSkills: ActivatedSkillEntry[];
  loadedTools: string[];
  offeredTools?: string[];
  loopWarned?: { signature: string };
  streaming?: { step: number; attempt: number; seen: boolean; items: { itemId: string; text: string }[] };
  mode?: PermissionMode;
  taskSeq: number;
  loopGroups: { signature: string; outputSignature?: string }[];
  loopOpen?: { calls: [string, unknown][]; callIds: string[]; outputs: Record<string, string> };
  inherited?: {
    fromRunId: string;
    fromLastSeq: number;
    digest: string;
    form?: 'reference';
    fromNextItemSeq?: number;
    compaction?: { runId: string; eventSeq: number };
    itemCount?: number;
  };
  ownCompactionEventSeq?: number;
  inheritedSummaryItem?: MessageInputItem;
  inheritedTruncations?: { callId: string; handle: string; kind: 'omitted' | 'truncated' | 'reference' }[];
  lastSeq: number;
};
