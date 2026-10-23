import type { Clock } from '@momonga/foundation';
import type { PermissionSubject, SideEffect } from '@momonga/policy';
import type { ToolKind } from '@momonga/protocol';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import type { BlobPort, ToolIdempotencyRecord } from './ports.ts';

export type ToolContent =
  | { type: 'content'; content: { type: 'text'; text: string } }
  | { type: 'diff'; path: string; oldText: string | null; newText: string };

export type PlanEntry = {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
};

export type ToolResult = {
  status: 'completed' | 'failed';
  output: string;
  content?: ToolContent[];
  plan?: PlanEntry[];
};

export type ToolSessionState = {
  cwd: string;
  readLedger: Map<string, { sha256: string; mtimeMs: number }>;
};

export type SubjectContext = {
  cwd: string;
  home: string;
  roots: readonly string[];
};

export type ToolContext = SubjectContext & {
  runId: string;
  step: number;
  callId: string;
  idemKey: string;
  outputBudgetChars: number;
  processMarker?: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  deadlineAt: number;
  sandbox: Sandbox;
  sandboxPolicy: SandboxPolicy;
  blobs: BlobPort;
  clock: Clock;
  session: ToolSessionState;
  attachProcess(process: { pgid: number; startedAt: number }): void;
  update(content: ToolContent[]): void;
};

export type ReconcileResult = {
  outcome: 'already_applied' | 'not_applied' | 'unknown';
  output: string;
};

export type ToolDefinition<Input> = {
  name: string;
  description: string;
  kind: ToolKind;
  sideEffect: SideEffect;
  inputSchema: Record<string, unknown>;
  pagesOutput?: true;
  timeoutMs: number | ((input: Input) => number);
  title(input: Input): string;
  locations?(input: Input): { path: string; line?: number }[];
  subject(input: Input, ctx: SubjectContext): PermissionSubject;
  prepare?(input: Input, ctx: ToolContext): Promise<Record<string, unknown>>;
  execute(input: Input, ctx: ToolContext, prepared: Record<string, unknown> | undefined): Promise<ToolResult>;
  reconcile?(input: Input, record: ToolIdempotencyRecord, ctx: ToolContext): Promise<ReconcileResult>;
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
