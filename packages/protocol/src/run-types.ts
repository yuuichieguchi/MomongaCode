import type { CompactionInputItem, InputItem, MessageInputItem } from './open-responses.ts';

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

export const STOP_REASONS = ['max_steps', 'budget', 'max_tokens', 'timeout', 'loop', 'approval_timeout', 'refusal'] as const;

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const;

export const APPROVAL_STATUSES = ['pending', 'resolved', 'superseded', 'expired', 'withdrawn'] as const;

export const TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type StopReason = (typeof STOP_REASONS)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type ToolKind = (typeof TOOL_KINDS)[number];

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export type ImageAttachment = { mediaType: ImageMediaType; data: string };

export type ElicitationRequestView =
  | { key: string; mode: 'form'; message: string; requestedSchema: Record<string, unknown> }
  | { key: string; mode: 'url'; message: string; url: string };

export type ElicitationAnswerRecord =
  | { action: 'accept'; content?: Record<string, string | number | boolean | string[]> }
  | { action: 'decline' }
  | { action: 'cancel' };

export type ModelResponse = {
  status: 'completed' | 'incomplete';
  incompleteReason?: string;
  output: unknown[];
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
};

export type ActivatedSkillRecord = { name: string; content: string };

export const JOB_STATUSES = ['running', 'exited', 'killed', 'unknown'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export type ToolAwait = { kind: 'run'; runId: string; sessionId: string; agent: string } | { kind: 'job'; jobId: string };

export type RunEventPayload =
  | { type: 'user.message'; text: string; images?: ImageAttachment[] }
  | { type: 'run.started'; attempt: number; now: number; pins: Record<string, unknown>; mode?: PermissionMode }
  | { type: 'run.status'; from: RunStatus; to: RunStatus; reason?: string }
  | { type: 'model.requested'; step: number; attempt: number; digest: string; body: unknown }
  | { type: 'model.responded'; step: number; attempt: number; response: ModelResponse }
  | { type: 'agent.message.delta'; step: number; attempt: number; itemId: string; text: string }
  | { type: 'agent.thought.delta'; step: number; attempt: number; itemId: string; text: string }
  | { type: 'model.stream.restarted'; step: number; attempt: number }
  | {
      type: 'tool.call';
      callId: string;
      providerCallId: string;
      name: string;
      kind: ToolKind;
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
      suggestedRule?: string;
    }
  | { type: 'tool.permission.resolved'; approvalId: string; optionId: string; rulePersisted?: boolean }
  | { type: 'tool.permission.cancelled'; approvalId: string; reason: 'expired' | 'withdrawn' | 'superseded' }
  | { type: 'tool.elicitation.requested'; inputId: string; callId: string; server: string; requests: ElicitationRequestView[] }
  | { type: 'tool.elicitation.resolved'; inputId: string; responses: Record<string, ElicitationAnswerRecord> }
  | { type: 'tool.elicitation.cancelled'; inputId: string; reason: 'expired' | 'withdrawn' | 'superseded' }
  | { type: 'mcp.authorization.required'; server: string; callId?: string }
  | { type: 'tool.started'; callId: string; idemKey: string }
  | { type: 'tool.updated'; callId: string; content: unknown[] }
  | {
      type: 'tool.completed';
      callId: string;
      status: 'completed' | 'failed';
      output: string;
      content?: unknown[];
      truncated?: boolean;
      handle?: string;
    }
  | { type: 'tool.reconciled'; callId: string; outcome: 'already_applied' | 'not_applied' | 'unknown'; output: string }
  | { type: 'tool.waiting'; callId: string; awaits: ToolAwait; wakeAt?: number }
  | { type: 'job.finished'; jobId: string; status: Exclude<JobStatus, 'running'>; exitCode?: number; signal?: string }
  | {
      type: 'plan.updated';
      entries: { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' }[];
    }
  | { type: 'usage.updated'; inputTokens: number; outputTokens: number; totalTokens: number }
  | { type: 'context.compacted'; item: CompactionInputItem; summary: string; replacedThroughSeq: number }
  | { type: 'context.compaction_rejected'; step?: number; attempt?: number; item: MessageInputItem }
  | {
      type: 'context.inherited';
      fromRunId: string;
      fromLastSeq: number;
      history: { seq: number; item: InputItem; callId?: string; handle?: string }[];
      nextItemSeq: number;
      summary?: { item: CompactionInputItem | MessageInputItem; summary: string; replacedThroughSeq: number };
      evicted: string[];
      closures: { callId: string; seq: number; effect: 'not_executed' | 'unknown'; announced: boolean }[];
      partial?: { seq: number };
      markers: { seq: number; kind: 'interrupted' | 'unprocessed' | 'dropped' | 'mode_changed' }[];
      fromMode?: PermissionMode;
      mode?: PermissionMode;
      activatedSkills?: ActivatedSkillRecord[];
      digest: string;
    }
  | { type: 'context.truncated'; callId: string; handle: string; kind: 'omitted' | 'truncated' }
  | { type: 'instructions.loaded'; path: string; content: string }
  | { type: 'skill.activated'; name: string; content: string }
  | { type: 'approval.rule.persisted'; approvalId: string; effect: 'allow' | 'deny'; rule: string }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string };

export type SessionEventPayload = { type: 'mode.changed'; mode: PermissionMode };

export type SessionEvent = SessionEventPayload & { id: number; sessionId: string; createdAt: number };

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

export type PendingCallStatus = 'requested' | 'awaiting_approval' | 'awaiting_input' | 'started' | 'completed' | 'reconciled';

export type RunState = {
  runId: string;
  sessionId: string;
  status: RunStatus;
  stopReason?: StopReason;
  step: number;
  attempt: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  history: { seq: number; item: InputItem; callId?: string; handle?: string }[];
  nextItemSeq: number;
  summary?: { item: CompactionInputItem | MessageInputItem; summary: string; replacedThroughSeq: number };
  evicted: string[];
  pins?: Record<string, unknown>;
  pendingCalls: Record<
    string,
    {
      name: string;
      providerCallId: string;
      arguments: unknown;
      status: PendingCallStatus;
      idemKey?: string;
      awaiting?: ToolAwait;
      approvalId?: string;
      options?: PermissionOption[];
      subjectDigest?: string;
      suggestedRule?: string;
      resolution?: { optionId: string; kind: PermissionOption['kind']; subjectDigest: string; suggestedRule?: string; rulePersisted?: true };
      input?: { inputId: string; server: string; requests: ElicitationRequestView[] };
      inputResolution?: { inputId: string; responses: Record<string, ElicitationAnswerRecord> };
    }
  >;
  inFlightModelRequest?: { step: number; attempt: number; digest: string; body: unknown; requestedSeq: number };
  notes: { level: 'info' | 'warning' | 'error'; message: string }[];
  toolCallCounts: Record<string, number>;
  steps: Record<number, { toolChoice: string; summary: boolean }>;
  lastResponse?: { step: number; incomplete: boolean; incompleteReason?: string; refusal: boolean; callIds: string[] };
  loadedInstructions: { path: string; textSha256: string }[];
  activatedSkills: ActivatedSkillRecord[];
  streaming?: { step: number; attempt: number; seen: boolean; items: { itemId: string; text: string }[] };
  mode?: PermissionMode;
  taskSeq: number;
  loopGroups: { signature: string; outputSignature?: string }[];
  loopOpen?: { calls: [string, unknown][]; callIds: string[]; outputs: Record<string, string> };
  inherited?: { fromRunId: string; fromLastSeq: number; digest: string };
  lastSeq: number;
};
