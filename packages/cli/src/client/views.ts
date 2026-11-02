import type { PermissionMode, PermissionOption, RunStatus, StopReason, ToolKind } from '@momonga/protocol';

export type SessionView = {
  readonly id: string;
  readonly cwd: string;
  readonly permissionMode: PermissionMode;
  readonly modelAlias: string;
  readonly bypassAllowed: boolean;
  readonly createdAt: number;
  readonly envKeys: readonly string[];
  readonly activeRunId: string | null;
  readonly latestRunId: string | null;
  readonly additionalDirectories: readonly string[];
};

export type RunUsage = { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number };

export type RunView = {
  readonly id: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly status: RunStatus;
  readonly stopReason?: StopReason;
  readonly error?: { readonly code: string; readonly message: string };
  readonly usage: RunUsage;
  readonly step: number;
  readonly createdAt: number;
  readonly deadlineAt: number;
  readonly cancelRequested: boolean;
  readonly lastSeq: number;
  readonly previousRunId: string | null;
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
  readonly runId: string;
  readonly callId: string;
  readonly status: 'pending' | 'resolved' | 'superseded' | 'expired' | 'withdrawn';
  readonly options: readonly PermissionOption[];
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly suggestedRule?: string;
  readonly toolCall: ApprovalToolCall;
};

export type TrustView = {
  readonly path: string;
  readonly decision: 'trusted' | 'untrusted' | null;
  readonly inheritedFrom?: string;
};

export type ErrorBody = {
  readonly error: { readonly type: string; readonly code: string; readonly message: string; readonly param?: string };
};
