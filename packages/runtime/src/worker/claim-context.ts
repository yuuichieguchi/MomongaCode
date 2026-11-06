import type { ModelRoles } from '@momonga/config';
import type { Calibration, TokenMeter } from '@momonga/context';
import type { Capabilities, FunctionTool, RunEventPayload } from '@momonga/protocol';
import type { SkillSet } from '@momonga/skills';
import type { Claim, Run, StatusPatch, WaitTargets } from '@momonga/store';
import type { ToolSet } from '@momonga/tools';
import type { MemorySet, ToolEnv, TraceSpan } from '../ports.ts';
import type { ClaimControl } from './claim-control.ts';
import type { Journal } from './journal.ts';
import type { RunLimits } from './limits.ts';
import type { ToolOffer } from './tool-offer.ts';
import type { ToolLoading } from './tool-admission.ts';
import type { TokenPolicy } from './token-pin.ts';
import type { WorkerOptions } from './types.ts';

export type Flow = 'continue' | 'done';

export type Terminals = {
  finish(to: 'COMPLETED' | 'STOPPED' | 'FAILED', patch?: StatusPatch, preceding?: readonly RunEventPayload[]): Promise<'done'>;
  yieldTo(to: 'WAITING_HUMAN' | 'WAITING_TOOL' | 'QUEUED', availableAt?: number, options?: { refundAttempt?: true; awaits?: WaitTargets }): 'done';
  cancel(): Promise<'done'>;
  yieldLease(): 'done';
};

export type ClaimContext = {
  options: WorkerOptions;
  claim: Claim;
  run: Run;
  alias: string;
  capabilities: Capabilities;
  roles: ModelRoles;
  memoryShare?: number;
  guideline?: { version: number; text: string };
  limits: RunLimits;
  toolSet: ToolSet;
  skills: SkillSet;
  recalled: MemorySet;
  usedMemoryIds: Set<string>;
  env: ToolEnv;
  functionTools(): FunctionTool[];
  toolOffer(loaded?: readonly string[]): ToolOffer;
  toolLoading?: ToolLoading;
  readers(): Readonly<Record<string, string>>;
  windowShared(): boolean;
  companions(): { hostOf: Readonly<Record<string, string>>; keepWithoutHost: boolean };
  systemPrompt: string;
  inlineLimitForReconcile: number;
  inlineLimitForExecution: () => Promise<number>;
  journal: Journal;
  control: ClaimControl;
  terminals: Terminals;
  agentSpan: TraceSpan;
  meter: TokenMeter;
  fallbackMeters: readonly TokenMeter[];
  counter: string;
  calibration: Calibration;
  targetFacts(target: string): Promise<{ meter: TokenMeter; capabilities: Capabilities; counter: string }>;
  pinnedDigest: { value: string | undefined };
  memory: RunMemory;
  verificationCommands: readonly string[];
  autoCompact: boolean;
  token: TokenPolicy;
};

export type RunMemory = { streak: number; interruptions: number; deadlineAt: number };
