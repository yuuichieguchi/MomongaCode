import type { ApprovalStatus, AutoClassifierView, ElicitationRequestView, PermissionMode, PermissionOption, PlanAccountRef, RunStatus, StopReason, Stored, ToolKind, RunReport } from '@momonga/protocol';

export type SessionView = {
  readonly id: string;
  readonly cwd: string;
  readonly permissionMode: PermissionMode;
  readonly model: string;
  readonly bypassAllowed: boolean;
  readonly createdAt: number;
  readonly envKeys: readonly string[];
  readonly activeRunId: string | null;
  readonly latestRunId: string | null;
  readonly additionalDirectories: readonly string[];
  readonly lastEventId: number;
  readonly autoClassifier?: AutoClassifierView;
};

export type RunUsage = { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number; readonly costNano?: number; readonly unpricedCalls?: number };

export type RunErrorView = { readonly code: string; readonly message: string; readonly plan?: PlanAccountRef };

export type RunView = {
  readonly id: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly status: RunStatus;
  readonly stopReason?: StopReason;
  readonly error?: RunErrorView;
  readonly usage: RunUsage;
  readonly step: number;
  readonly limits: { readonly maxSteps?: number; readonly maxTotalTokens?: number; readonly approvalTtlMs?: number; readonly loopThreshold?: number };
  readonly createdAt: number;
  readonly deadlineAt: number;
  readonly cancelRequested: boolean;
  readonly lastSeq: number;
  readonly previousRunId: string | null;
  readonly parentRunId: string | null;
  readonly parentCallId: string | null;
  readonly origin: 'trusted' | 'untrusted';
  readonly agent?: string;
  readonly report?: RunReport;
  readonly history: 'inherit' | 'fresh';
};

export type ApprovalToolCall = {
  readonly callId: string;
  readonly name: string;
  readonly title: string;
  readonly kind: ToolKind;
  readonly rawInput?: unknown;
  readonly locations?: readonly { readonly path: string; readonly line?: number }[];
};

export type ApprovalView = {
  readonly id: string;
  readonly kind: 'permission' | 'unknown_effect';
  readonly runId: string;
  readonly callId: string;
  readonly status: 'pending' | 'resolved' | 'superseded' | 'expired' | 'withdrawn';
  readonly options: readonly PermissionOption[];
  readonly createdAt: number;
  readonly suggestedRule?: string;
  readonly reason: string;
  readonly toolCall: ApprovalToolCall;
};

export type TrustView = {
  readonly path: string;
  readonly decision: Stored<'trusted' | 'untrusted'> | null;
  readonly inheritedFrom?: string;
};

export type ErrorBody = {
  readonly error: { readonly type: string; readonly code: string; readonly message: string; readonly param?: string };
};

export type ElicitationView = {
  readonly id: string;
  readonly runId: string;
  readonly callId: string;
  readonly status: ApprovalStatus;
  readonly server: string;
  readonly requests: readonly ElicitationRequestView[];
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly toolCall: { readonly callId: string; readonly name: string; readonly title: string };
};
