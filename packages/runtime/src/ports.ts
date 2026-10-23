import type { PermissionRule } from '@momonga/config';
import type { Clock } from '@momonga/foundation';
import type {
  Capabilities,
  CompactRequest,
  CompactResource,
  CountTokensRequest,
  CountTokensResult,
  CreateResponseBody,
  StreamEvent,
} from '@momonga/protocol';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import type { Session } from '@momonga/store';
import type { ToolExecutor, ToolSessionState, ToolSet } from '@momonga/tools';

export type { Clock };

export type GatewayCallOptions = {
  idempotencyKey: string;
  deadlineAt: number;
  signal: AbortSignal;
  traceparent?: string;
};

export type GatewayPort = {
  stream(body: CreateResponseBody, options: GatewayCallOptions): AsyncIterable<StreamEvent>;
  compact(request: CompactRequest, options: GatewayCallOptions): Promise<CompactResource>;
  countTokens(request: CountTokensRequest, options: { signal: AbortSignal }): Promise<CountTokensResult>;
  capabilities(alias: string): Promise<Capabilities>;
};

export type AppendedRule = { effect: 'allow' | 'deny'; rule: string };

export type SettingsPort = {
  rules(session: Session): Promise<PermissionRule[]>;
  appendRule(session: Session, entry: AppendedRule): Promise<void>;
  trusted(session: Session): boolean;
};

export type ToolRuntimePort = {
  toolSet(runId: string): Promise<ToolSet>;
  executor: ToolExecutor;
  sandbox: Sandbox;
  sandboxPolicy: SandboxPolicy;
  protectedPaths: readonly string[];
  sessionState(session: Session): ToolSessionState;
};

export type TraceSpan = {
  traceparent: string;
  end(error?: unknown): void;
};

export type AgentSpanInput = { runId: string; sessionId: string; attempt: number };

export type ToolSpanInput = { runId: string; step: number; callId: string; toolName: string; toolType: string };

export type TracerPort = {
  startAgentSpan(input: AgentSpanInput): TraceSpan;
  startToolSpan(parent: TraceSpan, input: ToolSpanInput): TraceSpan;
};
