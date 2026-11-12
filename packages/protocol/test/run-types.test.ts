import { describe, expect, expectTypeOf, it } from 'vitest';
import { RUN_STATUSES, STOP_REASONS, TERMINAL_STATUSES } from '@momonga/protocol';
import type {
  ApprovalBasis,
  CallTiming,
  CompactionInputItem,
  ContributionKind,
  ElicitationAnswerRecord,
  ElicitationRequestView,
  ImageAttachment,
  MessageAttachment,
  UserShellRecord,
  InheritedCopyPayload,
  InheritedReferencePayload,
  InputItem,
  MemoryStatus,
  MessageInputItem,
  RecordedModelCost,
  ModelResponse,
  PermissionMode,
  PermissionOption,
  ApprovalShown,
  PrefixEvent,
  RunEvent,
  RunEventPayload,
  RunState,
  RunStatus,
  StopReason,
  SummaryFidelity,
  TerminalStatus,
  TokenAnatomy,
  ToolAwait,
  ToolKind,
  UnpricedOutcome,
  WorkingFacts,
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
    expect(STOP_REASONS).toEqual(['max_steps', 'budget', 'max_tokens', 'timeout', 'loop', 'approval_timeout', 'refusal', 'usage_limit', 'conditions_unmet']);
  });
});

describe('run status types', () => {
  it('defines RunStatus, TerminalStatus and StopReason', () => {
    expectTypeOf<RunStatus>().toEqualTypeOf<
      'QUEUED' | 'RUNNING' | 'WAITING_TOOL' | 'WAITING_HUMAN' | 'CANCELLING' | 'COMPLETED' | 'STOPPED' | 'FAILED' | 'CANCELLED'
    >();
    expectTypeOf<TerminalStatus>().toEqualTypeOf<'COMPLETED' | 'STOPPED' | 'FAILED' | 'CANCELLED'>();
    expectTypeOf<StopReason>().toEqualTypeOf<
      'max_steps' | 'budget' | 'max_tokens' | 'timeout' | 'loop' | 'approval_timeout' | 'refusal' | 'usage_limit' | 'conditions_unmet'
    >();
    expectTypeOf<PermissionMode>().toEqualTypeOf<'manual' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'>();
    expectTypeOf<ToolKind>().toEqualTypeOf<
      'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other'
    >();
  });
});

describe('run event payloads', () => {
  it('discriminates on exactly these types', () => {
    expectTypeOf<RunEventPayload['type']>().toEqualTypeOf<
      | 'user.message'
      | 'context.compacting'
      | 'context.inherited_compacted'
      | 'tool.permission.classifying'
      | 'hook.started'
      | 'run.started'
      | 'attempt.failed'
      | 'attempt.lost'
      | 'run.status'
      | 'model.requested'
      | 'model.responded'
      | 'model.stream.restarted'
      | 'agent.message.delta'
      | 'agent.thought.delta'
      | 'tool.call'
      | 'tool.permission.requested'
      | 'tool.permission.classified'
      | 'hook.completed'
      | 'tool.permission.resolved'
      | 'tool.waiting'
      | 'job.finished'
      | 'tool.permission.cancelled'
      | 'tool.unknown.requested'
      | 'tool.unknown.resolved'
      | 'tool.unknown.cancelled'
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
      | 'usage.charged'
      | 'context.compacted'
      | 'context.compaction_rejected'
      | 'user.compact'
      | 'context.contribution'
      | 'context.governing_loaded'
      | 'context.inherited'
      | 'context.memories_loaded'
      | 'context.truncated'
      | 'instructions.loaded'
      | 'skill.activated'
      | 'verification.started'
      | 'verification.completed'
      | 'tool.loaded'
      | 'tool.offered'
      | 'loop.warned'
      | 'budget.exhausted'
      | 'tool.held'
      | 'tool.held.resolved'
      | 'run.quiescent'
      | 'meter.observed'
      | 'model.rejected'
      | 'approval.rule.persisted'
      | 'notice'
    >();
  });

  it('defines the conversation and lifecycle payloads', () => {
    expectTypeOf<Payload<'user.message'>>().toEqualTypeOf<{ type: 'user.message'; text: string; images?: ImageAttachment[]; source?: 'steer' | 'queue'; attachments?: MessageAttachment[]; shell?: UserShellRecord[] }>();
    expectTypeOf<Payload<'run.started'>>().toEqualTypeOf<{
      type: 'run.started';
      attempt: number;
      now: number;
      pins: Record<string, unknown>;
      mode?: PermissionMode;
    }>();
    expectTypeOf<Payload<'attempt.failed'>>().toEqualTypeOf<{ type: 'attempt.failed'; attempt: number; code: string; retryAt: number; limit: number }>();
    expectTypeOf<Payload<'attempt.lost'>>().toEqualTypeOf<{ type: 'attempt.lost'; lastLiveAt: number }>();
    expectTypeOf<Payload<'run.status'>>().toEqualTypeOf<{
      type: 'run.status';
      from: RunStatus;
      to: RunStatus;
      reason?: string;
    }>();
  });

  it('defines the model payloads with a loose response that 1.4 can tighten', () => {
    expectTypeOf<ModelResponse>().toEqualTypeOf<{
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
      momonga?: { cacheWriteInputTokens?: number; cacheReadNotReported?: true; cost?: RecordedModelCost; unpriced?: UnpricedOutcome; retryOf?: number };
      timing?: CallTiming;
    }>();
    expectTypeOf<Payload<'model.requested'>>().toEqualTypeOf<{
      type: 'model.requested';
      step: number;
      attempt: number;
      digest: string;
      pinnedDigest?: string;
      body: unknown;
      anatomy?: TokenAnatomy;
      prefix?: { preservedItems: number; toolsChanged: boolean; causes: PrefixEvent[] };
      budget?: { reservedTokens: number; reservedNano?: number; maxOutputTokens: number; quote?: { inUnits: string; outUnits: string; priceVersions: string[] } };
    }>();
    expectTypeOf<Payload<'model.responded'>>().toEqualTypeOf<{
      type: 'model.responded';
      step: number;
      attempt: number;
      response: ModelResponse;
      target?: string;
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
      sideEffect?: 'read_only' | 'write' | 'exec';
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
      reason: string;
      shown: ApprovalShown;
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
    expectTypeOf<Payload<'tool.started'>>().toEqualTypeOf<{ type: 'tool.started'; callId: string; idemKey: string; basis?: ApprovalBasis }>();
    expectTypeOf<Payload<'tool.updated'>>().toEqualTypeOf<{ type: 'tool.updated'; callId: string; content: unknown[] }>();
    expectTypeOf<Payload<'tool.completed'>>().toEqualTypeOf<{
      type: 'tool.completed';
      callId: string;
      status: 'completed' | 'failed';
      output: string;
      content?: unknown[];
      truncated?: boolean;
      handle?: string;
      denial?: { source: 'sandbox' | 'rule' | 'mode' | 'setting' | 'hook' | 'mandate' | 'superseded' | 'held'; reason: string };
      files?: { path: string; sha256?: string; access: 'read' | 'write' | 'remove' }[];
      mutated?: true;
      command?: string;
      windowShared?: true;
      memories?: string[];
      exitCode?: number;
      formatted?: { formatter: string; version: number };
      hunks?: { oldStart: number; newStart: number; lines: string[] }[];
      added?: number;
      removed?: number;
      diffOmitted?: string;
      effect?: { operation: string; target: string; outcome: 'applied' | 'already_applied' | 'failed' | 'unknown' };
      held?: { approvalId: string };
    }>();
    expectTypeOf<Payload<'tool.permission.classified'>>().toEqualTypeOf<{
      type: 'tool.permission.classified';
      callId: string;
      subjectDigest: string;
      model?: string;
      outcome: 'allow' | 'ask';
      verdict?: 'safe' | 'unsafe';
      confidence?: 'high' | 'medium' | 'low';
      rationale?: string;
      failure?: string;
    }>();
    expectTypeOf<Payload<'tool.reconciled'>>().toEqualTypeOf<{
      type: 'tool.reconciled';
      callId: string;
      outcome: 'already_applied' | 'not_applied' | 'unknown';
      output: string;
      interrupted?: 'timeout' | 'cancelled';
      files?: { path: string; sha256?: string; access: 'read' | 'write' | 'remove' }[];
      command?: string;
      effect?: { operation: string; target: string; outcome: 'applied' | 'already_applied' | 'failed' | 'unknown' };
      hunks?: { oldStart: number; newStart: number; lines: string[] }[];
      added?: number;
      removed?: number;
      diffOmitted?: string;
      held?: { approvalId: string };
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
      item: CompactionInputItem | MessageInputItem;
      summary: string;
      replacedThroughSeq: number;
      source?: 'model' | 'deterministic';
      fidelity?: SummaryFidelity;
      guidelineVersion?: number;
      tokensBefore?: number;
      tokensAfter?: number;
      tokensAfterEstimated?: true;
    }>();
    expectTypeOf<Payload<'context.governing_loaded'>>().toEqualTypeOf<{
      type: 'context.governing_loaded';
      active: { id: string; textSha256: string }[];
      conflicts: { target: string; ids: string[] }[];
    }>();
    expectTypeOf<Payload<'context.memories_loaded'>>().toEqualTypeOf<{
      type: 'context.memories_loaded';
      memories: { id: string; status: MemoryStatus }[];
    }>();
    expectTypeOf<Payload<'context.contribution'>>().toEqualTypeOf<{
      type: 'context.contribution';
      items: { kind: ContributionKind; id: string; contributed: boolean }[];
    }>();
    expectTypeOf<Payload<'context.compaction_rejected'>>().toEqualTypeOf<{
      type: 'context.compaction_rejected';
      step?: number;
      attempt?: number;
      item: MessageInputItem;
    }>();
    expectTypeOf<Payload<'context.inherited'>>().toEqualTypeOf<InheritedCopyPayload | InheritedReferencePayload>();
    expectTypeOf<InheritedCopyPayload>().toEqualTypeOf<{
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
      activatedSkills?: { name: string; content: string }[];
      digest: string;
    }>();
    expectTypeOf<Payload<'context.truncated'>>().toEqualTypeOf<{
      type: 'context.truncated';
      callId: string;
      handle: string;
      kind: 'omitted' | 'truncated' | 'reference';
      keptChars?: number;
      tokens?: number;
    }>();
    expectTypeOf<Payload<'instructions.loaded'>>().toEqualTypeOf<{ type: 'instructions.loaded'; path: string; content: string }>();
    expectTypeOf<Payload<'skill.activated'>>().toEqualTypeOf<{ type: 'skill.activated'; name: string; content: string }>();
    expectTypeOf<Payload<'tool.loaded'>>().toEqualTypeOf<{ type: 'tool.loaded'; names: string[] }>();
    expectTypeOf<Payload<'loop.warned'>>().toEqualTypeOf<{ type: 'loop.warned'; signature: string }>();
    expectTypeOf<Payload<'meter.observed'>>().toEqualTypeOf<{
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
    }>();
    expectTypeOf<Payload<'notice'>>().toEqualTypeOf<{
      type: 'notice';
      level: 'info' | 'warning' | 'error';
      message: string;
      code?: string;
      toolKey?: string;
      key?: string;
      reduction?: { turn: number; from: number; to: number };
    }>();
  });

  it('wraps a payload with its envelope in RunEvent', () => {
    expectTypeOf<Flat<Extract<RunEvent, { type: 'notice' }>>>().toEqualTypeOf<{
      type: 'notice';
      level: 'info' | 'warning' | 'error';
      message: string;
      code?: string;
      toolKey?: string;
      key?: string;
      reduction?: { turn: number; from: number; to: number };
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
      fence: string;
      status: RunStatus;
      stopReason?: StopReason;
      step: number;
      attempt: number;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number; costNano?: number; unpricedCalls?: number; legacyPrecisionCalls?: number };
      heldCalls?: Record<
        string,
        {
          name: string;
          providerCallId: string;
          arguments: unknown;
          step: number;
          approvalId: string;
          reason: string;
          sinceSeq: number;
          footprint: { reads: string[]; writes: string[] };
          subjectDigest?: string;
          options?: PermissionOption[];
          resolution?: { optionId: string; kind: PermissionOption['kind']; subjectDigest: string };
          cancelled?: 'expired' | 'withdrawn' | 'superseded';
        }
      >;
      quiescent?: true;
      rejectedCalls?: string[];
      history: { seq: number; item: InputItem; callId?: string; handle?: string; omittedTokens?: number }[];
      nextItemSeq: number;
      summary?: { item: CompactionInputItem | MessageInputItem; summary: string; replacedThroughSeq: number };
      workingFacts: WorkingFacts;
      evicted: string[];
      referencedOutputs?: string[];
      pins?: Record<string, unknown>;
      pendingCalls: Record<
        string,
        {
          name: string;
          providerCallId: string;
          arguments: unknown;
          status: 'requested' | 'awaiting_approval' | 'awaiting_input' | 'started' | 'completed' | 'reconciled';
          sideEffect?: 'read_only' | 'write' | 'exec';
          basis?: ApprovalBasis;
          idemKey?: string;
          awaiting?: ToolAwait;
          approvalId?: string;
          subjectDigest?: string;
          options?: PermissionOption[];
          suggestedRule?: string;
          classification?: { subjectDigest: string; outcome: 'allow' | 'ask' };
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
      notes: { level: 'info' | 'warning' | 'error'; message: string; code?: string; toolKey?: string; reduction?: { turn: number; from: number; to: number } }[];
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
      verification: {
        round: number;
        results: Record<string, { seq: number; outcome: 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'spawn_error'; mutationSeq: number; round?: number }>;
        pending?: Record<string, { round: number; attempt: number }>;
        lastFailure?: { round: number; mutationSeq: number };
        failureBefore?: number;
      };
      formsSinceCompaction: Record<string, number>;
      governingLoaded?: { active: { id: string; textSha256: string }[]; conflicts: { target: string; ids: string[] }[] };
      memoriesLoaded?: { id: string; status: MemoryStatus }[];
      activatedSkills: { name: string; content: string; seq: number }[];
      loadedTools: string[];
      offeredTools?: string[];
      loopWarned?: { signature: string };
      streaming?: { step: number; attempt: number; seen: boolean; items: { itemId: string; text: string }[]; thoughtIds: string[] };
      mode?: PermissionMode;
      loopGroups: { signature: string; outputSignature?: string }[];
      loopOpen?: { calls: [string, unknown][]; callIds: string[]; outputs: Record<string, string> };
      taskSeq: number;
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
      inheritedCompactionRecorded?: true;
      inheritedSummaryItem?: MessageInputItem;
      inheritedTruncations?: { callId: string; handle: string; kind: 'omitted' | 'truncated' | 'reference' }[];
      lastSeq: number;
    }>();
  });
});
