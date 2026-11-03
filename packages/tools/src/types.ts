import type { Clock } from '@momonga/foundation';
import type { PermissionSubject } from '@momonga/policy';
import type { ElicitationRequestView, SideEffect, ToolAwait, ToolFile, ToolKind } from '@momonga/protocol';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import type { BackgroundJobs, BlobPort, ToolIdempotencyRecord } from './ports.ts';

export type ToolContent =
  | { type: 'content'; content: { type: 'text'; text: string } }
  | { type: 'diff'; path: string; oldText: string | null; newText: string };

export type PlanEntry = {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
};

export type SkillActivation = { name: string; content: string };

export type ToolResult = {
  status: 'completed' | 'failed';
  output: string;
  content?: ToolContent[];
  plan?: PlanEntry[];
  skill?: SkillActivation;
  authorizationRequired?: { server: string };
  files?: ToolFile[];
  exitCode?: number;
};

export type ToolPending = { status: 'pending'; awaits: ToolAwait; wakeAt?: number };

export type ToolSessionState = {
  cwd: string;
  readLedger: Map<string, { sha256: string; mtimeMs: number }>;
};

export type SubjectContext = {
  cwd: string;
  home: string;
  roots: readonly string[];
};

export type ToolResume = {
  checkpoint: Record<string, unknown> | undefined;
  inputResponses: Record<string, unknown> | undefined;
};

export type ToolContext = ReconcileContext & {
  sandbox: Sandbox;
  sandboxPolicy: SandboxPolicy;
  resume?: ToolResume;
  checkpoint(state: Record<string, unknown> | undefined): void;
  extendToRunDeadline(): void;
};

export type ReconcileContext = SubjectContext & {
  runId: string;
  step: number;
  callId: string;
  idemKey: string;
  outputBudgetChars: number;
  tmpDir?: string;
  processMarker?: string;
  earlierAttempt?: { stopped: boolean; uninspectable?: ReadonlyArray<{ pid: number; command: string }> };
  traceparent?: string;
  tracestate?: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  deadlineAt: number;
  blobs: BlobPort;
  clock: Clock;
  jobs?: BackgroundJobs;
  session: ToolSessionState;
  attachProcess(process: { pgid: number; startedAt: number }): void;
  update(content: ToolContent[]): void;
};

export type ReconcileResult = {
  outcome: 'already_applied' | 'not_applied' | 'unknown';
  output: string;
};

export const TOOL_TIERS = ['essential', 'common', 'optional'] as const;

export type ToolTier = (typeof TOOL_TIERS)[number];

export type ToolDefinition<Input> = {
  name: string;
  description: string;
  kind: ToolKind;
  sideEffect: SideEffect;
  inputSchema: Record<string, unknown>;
  pagesOutput?: true;
  tier?: ToolTier;
  companionOf?: string;
  subjectKind?: PermissionSubject['kind'];
  schemaMode?: 'strict' | 'lenient';
  timeoutMs: number | ((input: Input) => number);
  title(input: Input): string;
  locations?(input: Input): { path: string; line?: number }[];
  subject(input: Input, ctx: SubjectContext): PermissionSubject;
  prepare?(input: Input, ctx: ToolContext): Promise<Record<string, unknown>>;
  execute(input: Input, ctx: ToolContext, prepared: Record<string, unknown> | undefined): Promise<ToolResult | ToolPending>;
  reconcile?(input: Input, record: ToolIdempotencyRecord, ctx: ReconcileContext): Promise<ReconcileResult>;
  releaseCheckpoint?(checkpoint: Record<string, unknown>, ctx: { signal: AbortSignal }): Promise<void>;
};

export type AnyTool = ToolDefinition<unknown>;

export const defineTool = <Input>(definition: ToolDefinition<Input>): AnyTool => definition as unknown as AnyTool;

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

export class TransientToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientToolError';
  }
}

export class ToolInputRequired extends Error {
  readonly server: string;
  readonly requests: ElicitationRequestView[];
  readonly checkpoint: Record<string, unknown>;

  constructor(input: { server: string; requests: ElicitationRequestView[]; checkpoint: Record<string, unknown> }) {
    super(`${input.server} needs input from the user: ${input.requests.map((request) => request.key).join(', ')}`);
    this.name = 'ToolInputRequired';
    this.server = input.server;
    this.requests = input.requests;
    this.checkpoint = input.checkpoint;
  }
}
