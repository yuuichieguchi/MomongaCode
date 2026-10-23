import type { CompactionInputItem, InputItem } from './open-responses.ts';

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

export const TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type StopReason = (typeof STOP_REASONS)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type ToolKind = (typeof TOOL_KINDS)[number];

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};

export type ModelResponse = {
  output: unknown[];
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
};

export type RunEventPayload =
  | { type: 'user.message'; text: string }
  | { type: 'run.started'; attempt: number; now: number; pins: Record<string, unknown> }
  | { type: 'run.status'; from: RunStatus; to: RunStatus; reason?: string }
  | { type: 'model.requested'; step: number; attempt: number; digest: string; body: unknown }
  | { type: 'model.responded'; step: number; attempt: number; response: ModelResponse }
  | { type: 'agent.message.delta'; step: number; attempt: number; itemId: string; text: string }
  | { type: 'agent.thought.delta'; step: number; attempt: number; itemId: string; text: string }
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
  | { type: 'tool.permission.requested'; approvalId: string; callId: string; options: PermissionOption[]; subjectDigest: string }
  | { type: 'tool.permission.resolved'; approvalId: string; optionId: string; rulePersisted?: boolean }
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
  | {
      type: 'plan.updated';
      entries: { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' }[];
    }
  | { type: 'mode.changed'; mode: PermissionMode }
  | { type: 'usage.updated'; inputTokens: number; outputTokens: number; totalTokens: number }
  | { type: 'context.compacted'; item: CompactionInputItem; summary: string; replacedThroughSeq: number }
  | { type: 'context.truncated'; callId: string; handle: string; kind: 'omitted' | 'truncated' }
  | { type: 'instructions.loaded'; path: string; content: string }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string };

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

export type PendingCallStatus = 'requested' | 'awaiting_approval' | 'started' | 'completed' | 'reconciled';

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
  summary?: { item: CompactionInputItem; summary: string; replacedThroughSeq: number };
  evicted: string[];
  pendingCalls: Record<
    string,
    {
      name: string;
      providerCallId: string;
      arguments: unknown;
      status: PendingCallStatus;
      idemKey?: string;
      approvalId?: string;
      options?: PermissionOption[];
      subjectDigest?: string;
      resolution?: { optionId: string; kind: PermissionOption['kind']; subjectDigest: string };
    }
  >;
  inFlightModelRequest?: { step: number; attempt: number; digest: string; body: unknown };
  notes: { level: 'info' | 'warning' | 'error'; message: string }[];
  toolCallCounts: Record<string, number>;
  lastSeq: number;
};
