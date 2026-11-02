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
import type { MemoryView } from '@momonga/protocol';
import type { AgentSet, ChildRuns } from '@momonga/agents';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import type { SkillSet } from '@momonga/skills';
import type { Session } from '@momonga/store';
import type { AnyTool, ToolExecutor, ToolSessionState, ToolSet } from '@momonga/tools';

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
  capabilities(alias: string, options: { signal: AbortSignal }): Promise<Capabilities>;
  cancel(idempotencyKey: string, options: { signal: AbortSignal }): Promise<boolean>;
};

export type AppendedRule = { effect: 'allow' | 'deny'; rule: string };

export type SettingsPort = {
  rules(session: Session): Promise<PermissionRule[]>;
  appendRule(session: Session, entry: AppendedRule): Promise<void>;
  trusted(session: Session): boolean;
};

export type SkillsPort = {
  load(session: Session): Promise<SkillSet>;
};

export type MemorySet = {
  memories: readonly MemoryView[];
  tools: readonly AnyTool[];
  markUsed(ids: readonly string[]): void;
};

export type MemoryPort = {
  load(session: Session): MemorySet;
};

export type AgentsPort = { load(session: Session): Promise<AgentSet>; runs: ChildRuns };

export type ToolEnv = Readonly<Record<string, string>>;

export type ToolPolicy = {
  roots: readonly string[];
  sandboxPolicy: SandboxPolicy;
  tmpDir: string;
  env: ToolEnv;
};

export type RecoveryContext = { roots: readonly string[]; tmpDir: string; env: ToolEnv };

export type ToolRuntimePort = {
  envFor(session: Session): ToolEnv;
  toolSet(runId: string, options: { signal: AbortSignal; env: ToolEnv; additionalTools?: readonly AnyTool[]; only?: readonly string[] }): Promise<ToolSet>;
  recoveryToolSet(options: { signal: AbortSignal }): Promise<ToolSet>;
  policyFor(session: Session, options: { env: ToolEnv; rules: readonly PermissionRule[]; readableDirectories?: readonly string[] }): Promise<ToolPolicy>;
  recoveryContextFor(session: Session, options: { env: ToolEnv }): Promise<RecoveryContext>;
  executor: ToolExecutor;
  sandbox: Sandbox;
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
