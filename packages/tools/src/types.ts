import type { CallStop } from './call-stop.ts';
import type { Clock } from '@momonga/foundation';
import type { MarkerSettle } from './marker-settle.ts';
import type { PermissionSubject } from '@momonga/policy';
import type { ElicitationRequestView, ReferenceKind, SideEffect, ToolAwait, ToolFile, ToolKind } from '@momonga/protocol';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import type { RipgrepLocator } from './ripgrep-locator.ts';
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

export type ToolBackend = { source: string; version: string };

export type ToolResult = {
  status: 'completed' | 'failed';
  output: string;
  content?: ToolContent[];
  plan?: PlanEntry[];
  skill?: SkillActivation;
  toolsLoaded?: string[];
  authorizationRequired?: { server: string };
  files?: ToolFile[];
  command?: string;
  windowShared?: true;
  detached?: true;
  memories?: string[];
  exitCode?: number;
  validatorFailure?: string;
  backend?: ToolBackend;
};

export type ToolPending = { status: 'pending'; awaits: ToolAwait; wakeAt?: number };

export type ToolSessionState = {
  cwd: string;
  workingDirectory: string;
  readLedger: Map<string, { sha256: string; mtimeMs: number }>;
};

export type SubjectContext = {
  cwd: string;
  workingDirectory: string;
  home: string;
  roots: readonly string[];
};

export type DisplayContext = Pick<SubjectContext, 'cwd' | 'workingDirectory'>;

export type ToolResume = {
  checkpoint: Record<string, unknown> | undefined;
  inputResponses: Record<string, unknown> | undefined;
};

export type ToolContext = ReconcileContext & {
  markerFd?: number;
  markerSettle?: MarkerSettle;
  sandbox: Sandbox;
  sandboxPolicy: SandboxPolicy;
  ripgrep: RipgrepLocator;
  resume?: ToolResume;
  checkpoint(state: Record<string, unknown> | undefined): void;
  reportProgress(): void;
};

export type ToolStop = { bound: CallStop['bound']; ms: number; checkpoint: Record<string, unknown> | undefined };

export type OutputFit = {
  fits(text: string): Promise<boolean>;
  fit(text: string, handle: string): Promise<string>;
  ready?(): Promise<void>;
};

export type ReconcileContext = SubjectContext & {
  runId: string;
  step: number;
  callId: string;
  idemKey: string;
  outputFit: OutputFit;
  tmpDir?: string;
  processMarker?: string;
  earlierAttempt?: { stopped: boolean };
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

type SubjectKind = PermissionSubject['kind'];

type DeclaredSubject<Input> = {
  [Kind in SubjectKind]: { subjectKind: Kind; subject(input: Input, ctx: SubjectContext): Extract<PermissionSubject, { kind: Kind }> };
}[SubjectKind];

type UndeclaredSubject<Input> = { subjectKind?: never; subject(input: Input, ctx: SubjectContext): PermissionSubject };

export type SideEffectBinding<Input> =
  | ({ sideEffect: 'read_only' } & (DeclaredSubject<Input> | UndeclaredSubject<Input>))
  | ({ sideEffect: Exclude<SideEffect, 'read_only'> } & DeclaredSubject<Input>);

export const TOOL_OUTPUT_ORIGINS = ['external', 'harness'] as const;

export type ToolOutputOrigin = (typeof TOOL_OUTPUT_ORIGINS)[number];

export type ToolDefinition<Input> = SideEffectBinding<Input> & ToolBody<Input>;

export type ToolBody<Input> = {
  name: string;
  description: string;
  conciseDescription?: string;
  conciseParameterDescriptions?: Readonly<Record<string, string>>;
  kind: ToolKind;
  inputSchema: Record<string, unknown>;
  pagesOutput?: true;
  output?: ToolOutputOrigin;
  tier?: ToolTier;
  reads?: ReferenceKind;
  companionOf?: string;
  outputSchema?: Record<string, unknown>;
  server?: string;
  validatorIdentity?: string;
  timeoutMs: number | ((input: Input) => number);
  idleTimeoutMs?: number;
  stopText?(stop: ToolStop): Promise<string>;
  title(input: Input, ctx: DisplayContext): string;
  locations?(input: Input, ctx: DisplayContext): { path: string; line?: number }[];
  prepare?(input: Input, ctx: ToolContext): Promise<Record<string, unknown>>;
  execute(input: Input, ctx: ToolContext, prepared: Record<string, unknown> | undefined): Promise<ToolResult | ToolPending>;
  reconcile?(input: Input, record: ToolIdempotencyRecord, ctx: ReconcileContext): Promise<ReconcileResult>;
  releaseCheckpoint?(checkpoint: Record<string, unknown>, ctx: { signal: AbortSignal }): Promise<void>;
};

export type AnyTool = ToolDefinition<unknown>;

export const outputOriginOf = (tool: AnyTool): ToolOutputOrigin => (tool.server === undefined ? (tool.output ?? 'external') : 'external');

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
