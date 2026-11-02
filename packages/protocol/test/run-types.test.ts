import { describe, expect, expectTypeOf, it } from 'vitest';
import { RUN_STATUSES, STOP_REASONS, TERMINAL_STATUSES } from '@momonga/protocol';
import type {
  CompactionInputItem,
  ElicitationAnswerRecord,
  ElicitationRequestView,
  ImageAttachment,
  InputItem,
  MessageInputItem,
  ModelResponse,
  PermissionMode,
  PermissionOption,
  RunEvent,
  RunEventPayload,
  RunState,
  RunStatus,
  StopReason,
  TerminalStatus,
  ToolKind,
} from '@momonga/protocol';

type Flat<T> = { [K in keyof T]: T[K] };
type Payload<T extends RunEventPayload['type']> = Flat<Extract<RunEventPayload, { type: T }>>;

describe('run status constants', () => {
  it('lists every run status in lifecycle order', () => {
    expect(RUN_STATUSES).toEqual([
      'QUEUED',
      'RUNNING',
      'WAITING_TOOL',
      'WAITING_HUMAN',
      'CANCELLING',
      'COMPLETED',
      'STOPPED',
      'FAILED',
      'CANCELLED',
    ]);
  });

  it('lists the terminal statuses', () => {
    expect(TERMINAL_STATUSES).toEqual(['COMPLETED', 'STOPPED', 'FAILED', 'CANCELLED']);
  });

  it('lists the stop reasons', () => {
    expect(STOP_REASONS).toEqual(['max_steps', 'budget', 'max_tokens', 'timeout', 'loop', 'approval_timeout', 'refusal']);
  });
});

describe('run status types', () => {
  it('defines RunStatus, TerminalStatus and StopReason', () => {
    expectTypeOf<RunStatus>().toEqualTypeOf<
      'QUEUED' | 'RUNNING' | 'WAITING_TOOL' | 'WAITING_HUMAN' | 'CANCELLING' | 'COMPLETED' | 'STOPPED' | 'FAILED' | 'CANCELLED'
    >();
    expectTypeOf<TerminalStatus>().toEqualTypeOf<'COMPLETED' | 'STOPPED' | 'FAILED' | 'CANCELLED'>();
    expectTypeOf<StopReason>().toEqualTypeOf<
      'max_steps' | 'budget' | 'max_tokens' | 'timeout' | 'loop' | 'approval_timeout' | 'refusal'
    >();
    expectTypeOf<PermissionMode>().toEqualTypeOf<'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'>();
    expectTypeOf<ToolKind>().toEqualTypeOf<
      'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other'
    >();
  });
});

describe('run event payloads', () => {
  it('discriminates on exactly these types', () => {
    expectTypeOf<RunEventPayload['type']>().toEqualTypeOf<
      | 'user.message'
      | 'run.started'
      | 'run.status'
      | 'model.requested'
      | 'model.responded'
      | 'model.stream.restarted'
      | 'agent.message.delta'
      | 'agent.thought.delta'
      | 'tool.call'
      | 'tool.permission.requested'
      | 'tool.permission.resolved'
      | 'tool.permission.cancelled'
      | 'tool.elicitation.requested'
      | 'tool.elicitation.resolved'
      | 'tool.elicitation.cancelled'
      | 'mcp.authorization.required'
      | 'tool.started'
      | 'tool.updated'
      | 'tool.completed'
      | 'tool.reconciled'
      | 'plan.updated'
      | 'usage.updated'
      | 'context.compacted'
      | 'context.compaction_rejected'
      | 'context.inherited'
      | 'context.truncated'
      | 'instructions.loaded'
      | 'skill.activated'
      | 'approval.rule.persisted'
      | 'notice'
    >();
  });

  it('defines the conversation and lifecycle payloads', () => {
    expectTypeOf<Payload<'user.message'>>().toEqualTypeOf<{ type: 'user.message'; text: string; images?: ImageAttachment[] }>();
    expectTypeOf<Payload<'run.started'>>().toEqualTypeOf<{
      type: 'run.started';
      attempt: number;
      now: number;
      pins: Record<string, unknown>;
      mode?: PermissionMode;
    }>();
    expectTypeOf<Payload<'run.status'>>().toEqualTypeOf<{
      type: 'run.status';
      from: RunStatus;
      to: RunStatus;
      reason?: string;
    }>();
  });

  it('defines the model payloads with a loose response that 1.4 can tighten', () => {
    expectTypeOf<ModelResponse>().toEqualTypeOf<{
      status: 'completed' | 'incomplete';
      incompleteReason?: string;
      output: unknown[];
      usage: { input_tokens: number; output_tokens: number; total_tokens: number };
    }>();
    expectTypeOf<Payload<'model.requested'>>().toEqualTypeOf<{
      type: 'model.requested';
      step: number;
      attempt: number;
      digest: string;
      body: unknown;
    }>();
    expectTypeOf<Payload<'model.responded'>>().toEqualTypeOf<{
      type: 'model.responded';
      step: number;
      attempt: number;
      response: ModelResponse;
    }>();
    expectTypeOf<Payload<'agent.message.delta'>>().toEqualTypeOf<{
      type: 'agent.message.delta';
      step: number;
      attempt: number;
      itemId: string;
      text: string;
    }>();
    expectTypeOf<Payload<'agent.thought.delta'>>().toEqualTypeOf<{
      type: 'agent.thought.delta';
      step: number;
      attempt: number;
      itemId: string;
      text: string;
    }>();
  });

  it('defines the tool payloads', () => {
    expectTypeOf<PermissionOption>().toEqualTypeOf<{
      optionId: string;
      name: string;
      kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    }>();
    expectTypeOf<Payload<'tool.call'>>().toEqualTypeOf<{
      type: 'tool.call';
      callId: string;
      providerCallId: string;
      name: string;
      kind: ToolKind;
      title: string;
      rawInput: unknown;
      locations?: { path: string; line?: number }[];
    }>();
    expectTypeOf<Payload<'tool.permission.requested'>>().toEqualTypeOf<{
      type: 'tool.permission.requested';
      approvalId: string;
      callId: string;
      options: PermissionOption[];
      subjectDigest: string;
      suggestedRule?: string;
    }>();
    expectTypeOf<Payload<'tool.permission.resolved'>>().toEqualTypeOf<{
      type: 'tool.permission.resolved';
      approvalId: string;
      optionId: string;
      rulePersisted?: boolean;
    }>();
    expectTypeOf<Payload<'tool.permission.cancelled'>>().toEqualTypeOf<{
      type: 'tool.permission.cancelled';
      approvalId: string;
      reason: 'expired' | 'withdrawn' | 'superseded';
    }>();
    expectTypeOf<Payload<'tool.started'>>().toEqualTypeOf<{ type: 'tool.started'; callId: string; idemKey: string }>();
    expectTypeOf<Payload<'tool.updated'>>().toEqualTypeOf<{ type: 'tool.updated'; callId: string; content: unknown[] }>();
    expectTypeOf<Payload<'tool.completed'>>().toEqualTypeOf<{
      type: 'tool.completed';
      callId: string;
      status: 'completed' | 'failed';
      output: string;
      content?: unknown[];
      truncated?: boolean;
      handle?: string;
    }>();
    expectTypeOf<Payload<'tool.reconciled'>>().toEqualTypeOf<{
      type: 'tool.reconciled';
      callId: string;
      outcome: 'already_applied' | 'not_applied' | 'unknown';
      output: string;
    }>();
  });

  it('defines the plan, usage and context payloads', () => {
    expectTypeOf<Payload<'plan.updated'>>().toEqualTypeOf<{
      type: 'plan.updated';
      entries: { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' }[];
    }>();
    expectTypeOf<Payload<'usage.updated'>>().toEqualTypeOf<{
      type: 'usage.updated';
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }>();
    expectTypeOf<Payload<'context.compacted'>>().toEqualTypeOf<{
      type: 'context.compacted';
      item: CompactionInputItem;
      summary: string;
      replacedThroughSeq: number;
    }>();
    expectTypeOf<Payload<'context.compaction_rejected'>>().toEqualTypeOf<{
      type: 'context.compaction_rejected';
      step?: number;
      attempt?: number;
      item: MessageInputItem;
    }>();
    expectTypeOf<Payload<'context.inherited'>>().toEqualTypeOf<{
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
      activatedSkills?: { name: string; content: string }[];
      digest: string;
    }>();
    expectTypeOf<Payload<'context.truncated'>>().toEqualTypeOf<{
      type: 'context.truncated';
      callId: string;
      handle: string;
      kind: 'omitted' | 'truncated';
    }>();
    expectTypeOf<Payload<'instructions.loaded'>>().toEqualTypeOf<{ type: 'instructions.loaded'; path: string; content: string }>();
    expectTypeOf<Payload<'skill.activated'>>().toEqualTypeOf<{ type: 'skill.activated'; name: string; content: string }>();
    expectTypeOf<Payload<'notice'>>().toEqualTypeOf<{
      type: 'notice';
      level: 'info' | 'warning' | 'error';
      message: string;
    }>();
  });

  it('wraps a payload with its envelope in RunEvent', () => {
    expectTypeOf<Flat<Extract<RunEvent, { type: 'notice' }>>>().toEqualTypeOf<{
      type: 'notice';
      level: 'info' | 'warning' | 'error';
      message: string;
      id: number;
      runId: string;
      sessionId: string;
      seq: number;
      step: number;
      leaseToken: number;
      createdAt: number;
    }>();
  });
});

describe('RunState', () => {
  it('defines the folded recovery state', () => {
    expectTypeOf<RunState>().toEqualTypeOf<{
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
          status: 'requested' | 'awaiting_approval' | 'awaiting_input' | 'started' | 'completed' | 'reconciled';
          idemKey?: string;
          approvalId?: string;
          subjectDigest?: string;
          options?: PermissionOption[];
          suggestedRule?: string;
          resolution?: {
            optionId: string;
            kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
            subjectDigest: string;
            suggestedRule?: string;
            rulePersisted?: true;
          };
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
      activatedSkills: { name: string; content: string }[];
      streaming?: { step: number; attempt: number; seen: boolean; items: { itemId: string; text: string }[] };
      mode?: PermissionMode;
      loopGroups: { signature: string; outputSignature?: string }[];
      loopOpen?: { calls: [string, unknown][]; callIds: string[]; outputs: Record<string, string> };
      taskSeq: number;
      inherited?: { fromRunId: string; fromLastSeq: number; digest: string };
      lastSeq: number;
    }>();
  });
});
