import type { Lease, PermissionRule, ResolvedContextSettings, ResolvedMemorySettings, ResolvedToolsSettings, ResolvedVerificationSettings } from '@momonga/config';
import type { Clock, LockCapabilityProbe, ProcessInspector, RuleEnforcement, SandboxNetworkSetting, UnixSocketPolicy, VerdictSubject } from '@momonga/foundation';
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
import type { MemoryView, ModelQuote, PermissionMode, RuleVerdict, TargetAnswers } from '@momonga/protocol';
import type { GatewayListing, GatewayModel } from './gateway-client.ts';
import type { AgentSet, ChildRuns } from '@momonga/agents';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import type { SkillSet } from '@momonga/skills';
import type { Session } from '@momonga/store';
import type { AnyTool, MarkerOwners, RipgrepLocator, ShellHost, ToolExecutor, ToolSessionState, ToolSet, UserCommandOutcome, WorkTreeObserver } from '@momonga/tools';
import type { AttachedMentions } from '@momonga/context';

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
  capabilities(model: string, options: { signal: AbortSignal; target?: string }): Promise<Capabilities>;
  model(model: string, options: { signal: AbortSignal }): Promise<GatewayModel>;
  listing(options: { signal: AbortSignal }): Promise<GatewayListing>;
  cancel(idempotencyKey: string, options: { signal: AbortSignal }): Promise<boolean>;
  quote(model: string, options: { signal: AbortSignal }): Promise<ModelQuote>;
};

export type AppendedRule = { effect: 'allow' | 'deny'; rule: string };

export type TargetFacts = { adapter: string; model: string; answers?: TargetAnswers };

export type SettingsPort = {
  rules(session: Session, signal: AbortSignal): Promise<PermissionRule[]>;
  hooks(session: Session, signal: AbortSignal): Promise<HooksSettings>;
  verification(session: Session, signal: AbortSignal): Promise<ResolvedVerificationSettings>;
  memory(target: Pick<Session, 'cwd'>, signal: AbortSignal): Promise<ResolvedMemorySettings>;
  context(session: Session, signal: AbortSignal): Promise<ResolvedContextSettings>;
  tools(session: Session, signal: AbortSignal): Promise<ResolvedToolsSettings>;
  autoModeClassifier(): string | undefined;
  appendRule(session: Session, entry: AppendedRule, signal: AbortSignal): Promise<void>;
  trusted(session: Session, signal: AbortSignal): Promise<boolean>;
};

export type AttachTerms = { ceiling: number; imageInput: boolean; signal: AbortSignal };

export type UserShellIo = { signal: AbortSignal; onUnprotected(reason: string): void; onOutput(text: string): void };

export type UserInputPort = {
  attach(session: Session, text: string, terms: AttachTerms): Promise<AttachedMentions>;
  shell(session: Session, command: string, io: UserShellIo): Promise<UserCommandOutcome>;
};

export type SkillsPort = {
  load(session: Session, signal: AbortSignal): Promise<SkillSet>;
};

export type RecallCapacity = { capabilities: Capabilities; memoryShare?: number | undefined };

export type RecallRequest = { query: string; capacity: RecallCapacity; pinnedIds?: readonly string[] };

export type MemorySet = {
  prepare(request: RecallRequest): Promise<void>;
  ranked(): readonly MemoryView[];
  hasMore(): boolean;
  matchCap(): number | undefined;
  tools: readonly AnyTool[];
};

export type MemoryPort = {
  load(session: Session, signal: AbortSignal): Promise<MemorySet>;
};

export type GovernanceSet = { tools: readonly AnyTool[] };

export type GovernancePort = {
  load(session: Session, signal: AbortSignal): Promise<GovernanceSet>;
};

export type HistorySet = { tools: readonly AnyTool[] };

export type HistoryPort = {
  load(session: Session, signal: AbortSignal): Promise<HistorySet>;
};

export type AgentCatalogPort = { load(session: Session, signal: AbortSignal): Promise<AgentSet> };

export type AgentsPort = AgentCatalogPort & { runs: ChildRuns };

export type ToolEnv = Readonly<Record<string, string>>;

export type ToolPolicy = {
  roots: readonly string[];
  sandboxPolicy: SandboxPolicy;
  sandboxNetwork?: SandboxNetworkSetting;
  tmpDir: string;
  env: ToolEnv;
};

export type RecoveryContext = { roots: readonly string[]; tmpDir: string; env: ToolEnv };

export type SandboxBinding = { readonly sandbox: Sandbox; readonly ruleEnforcement: RuleEnforcement };

export type SandboxBindings = { acquire(signal: AbortSignal): Promise<Lease<SandboxBinding>> };

export type RuleVerifyRequest = {
  rules: readonly PermissionRule[];
  roots: readonly string[];
  mode: PermissionMode;
  home: string;
  cwd: string;
  exemptDirectory: string | null;
  enforcement: RuleEnforcement;
  unixSockets: UnixSocketPolicy;
};

export type RuleVerification = { verdict: RuleVerdict; report: string };

export type RuleVerifierPort = {
  solverVersion(): Promise<string>;
  inputOf(request: RuleVerifyRequest, signal: AbortSignal): Promise<VerdictSubject>;
  needsVerdict(input: VerdictSubject): Promise<boolean>;
  verify(input: VerdictSubject, signal: AbortSignal): Promise<RuleVerdict>;
  report(input: VerdictSubject, signal: AbortSignal): Promise<RuleVerification>;
};

export type ToolRuntimePort = {
  envFor(session: Session, signal: AbortSignal): ToolEnv | Promise<ToolEnv>;
  toolSet(runId: string, options: { signal: AbortSignal; env: ToolEnv; additionalTools?: readonly AnyTool[]; only?: readonly string[] }): Promise<ToolSet>;
  recoveryToolSet(options: { signal: AbortSignal; additionalTools?: readonly AnyTool[] }): Promise<ToolSet>;
  policyFor(session: Session, options: { env: ToolEnv; rules: readonly PermissionRule[]; readableDirectories?: readonly string[]; ruleEnforcement: RuleEnforcement; signal: AbortSignal; discoverGitConfig?: true }): Promise<ToolPolicy>;
  recoveryContextFor(session: Session, options: { env: ToolEnv; signal: AbortSignal }): Promise<RecoveryContext>;
  executor: ToolExecutor;
  sandboxes: SandboxBindings;
  ripgrepLocator(env: ToolEnv): RipgrepLocator;
  shellHost: ShellHost;
  markerDir: string;
  owners?: MarkerOwners;
  lockCapability?: LockCapabilityProbe;
  inspector: ProcessInspector;
  sessionState(session: Session): ToolSessionState;
  workTreeObserver(session: Session, trusted: boolean): WorkTreeObserver;
};

export type TraceSpan = {
  traceparent: string;
  recordToolContent(content: { arguments: unknown; result?: unknown }): void;
  recordToolBackend(backend: { source: string; version: string }): void;
  end(error?: unknown): void;
};

export type TracerLeases = { acquire(signal: AbortSignal): Promise<Lease<TracerPort>> };

export type AgentSpanInput = { runId: string; sessionId: string; attempt: number };

export type ToolSpanInput = { runId: string; step: number; callId: string; toolName: string; toolType: string };

export type TracerPort = {
  startAgentSpan(input: AgentSpanInput): TraceSpan;
  startToolSpan(parent: TraceSpan, input: ToolSpanInput): TraceSpan;
};
