import type { AutoGateInput, ModelRoles, PermissionRule, ResolvedContextSettings, ResolvedMemorySettings, ResolvedToolsSettings, ResolvedVerificationSettings } from '@momonga/config';
import type { Clock } from '@momonga/foundation';
import type {
  Capabilities,
  CompactRequest,
  CompactResource,
  CountTokensRequest,
  CountTokensResult,
  CreateResponseBody,
  HeaderRole,
  HooksSettings,
  StreamEvent,
} from '@momonga/protocol';
import type { MemoryView } from '@momonga/protocol';
import type { GatewayModel } from './gateway-client.ts';
import type { AgentSet, ChildRuns } from '@momonga/agents';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import type { SkillSet } from '@momonga/skills';
import type { Session } from '@momonga/store';
import type { AnyTool, ShellHost, ToolExecutor, ToolSessionState, ToolSet } from '@momonga/tools';

export type { Clock };

export type GatewayCallOptions = {
  idempotencyKey: string;
  deadlineAt: number;
  signal: AbortSignal;
  traceparent?: string;
  runId?: string;
  role?: HeaderRole;
};

export type GatewayPort = {
  stream(body: CreateResponseBody, options: GatewayCallOptions): AsyncIterable<StreamEvent>;
  compact(request: CompactRequest, options: GatewayCallOptions): Promise<CompactResource>;
  countTokens(request: CountTokensRequest, options: { signal: AbortSignal }): Promise<CountTokensResult>;
  capabilities(alias: string, options: { signal: AbortSignal; target?: string }): Promise<Capabilities>;
  model(alias: string, options: { signal: AbortSignal }): Promise<GatewayModel>;
  cancel(idempotencyKey: string, options: { signal: AbortSignal }): Promise<boolean>;
};

export type AppendedRule = { effect: 'allow' | 'deny'; rule: string };

export type SettingsPort = {
  rules(session: Session): Promise<PermissionRule[]>;
  hooks(session: Session): Promise<HooksSettings>;
  verification(session: Session): Promise<ResolvedVerificationSettings>;
  memory(target: Pick<Session, 'cwd'>): Promise<ResolvedMemorySettings>;
  context(session: Session): Promise<ResolvedContextSettings>;
  tools(session: Session): Promise<ResolvedToolsSettings>;
  autoModeClassifier(): string | undefined;
  autoModeGate(): AutoGateInput | undefined;
  modelRoles(): ModelRoles;
  appendRule(session: Session, entry: AppendedRule): Promise<void>;
  trusted(session: Session): boolean;
};

export type SkillsPort = {
  load(session: Session): Promise<SkillSet>;
};

export type MemorySet = {
  memories: readonly MemoryView[];
  rank(query: string): readonly MemoryView[];
  tools: readonly AnyTool[];
  markUsed(ids: readonly string[]): void;
};

export type MemoryPort = {
  load(session: Session, signal: AbortSignal): Promise<MemorySet>;
};

export type GovernanceSet = { tools: readonly AnyTool[] };

export type GovernancePort = {
  load(session: Session): GovernanceSet;
};

export type HistorySet = { tools: readonly AnyTool[] };

export type HistoryPort = {
  load(session: Session): HistorySet;
};

export type AgentCatalogPort = { load(session: Session): Promise<AgentSet> };

export type AgentsPort = AgentCatalogPort & { runs: ChildRuns };

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
  recoveryToolSet(options: { signal: AbortSignal; additionalTools?: readonly AnyTool[] }): Promise<ToolSet>;
  policyFor(session: Session, options: { env: ToolEnv; rules: readonly PermissionRule[]; readableDirectories?: readonly string[] }): Promise<ToolPolicy>;
  recoveryContextFor(session: Session, options: { env: ToolEnv }): Promise<RecoveryContext>;
  executor: ToolExecutor;
  sandbox: Sandbox;
  shellHost: ShellHost;
  markerDir: string;
  sessionState(session: Session): ToolSessionState;
};

export type TraceSpan = {
  traceparent: string;
  recordToolContent(content: { arguments: unknown; result?: unknown }): void;
  end(error?: unknown): void;
};

export type AgentSpanInput = { runId: string; sessionId: string; attempt: number };

export type ToolSpanInput = { runId: string; step: number; callId: string; toolName: string; toolType: string };

export type TracerPort = {
  startAgentSpan(input: AgentSpanInput): TraceSpan;
  startToolSpan(parent: TraceSpan, input: ToolSpanInput): TraceSpan;
};
