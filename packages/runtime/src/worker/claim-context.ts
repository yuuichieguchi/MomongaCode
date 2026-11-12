import type { ModelRoles } from '@momonga/config';
import type { Calibration, TokenMeter } from '@momonga/context';
import type { Capabilities, FunctionTool, PinnedCondition, RunEventPayload } from '@momonga/protocol';
import type { SkillSet } from '@momonga/skills';
import type { Claim, Run, StatusPatch, WaitTargets } from '@momonga/store';
import type { OutputFit, ToolSet } from '@momonga/tools';
import type { MemorySet, ToolEnv, TracerPort, TraceSpan } from '../ports.ts';
import type { ClaimControl } from './claim-control.ts';
import type { Delegation } from './held-calls.ts';
import type { Journal } from './journal.ts';
import type { BudgetAccount } from './admitted-request.ts';
import type { PermissionRule } from '@momonga/config';
import type { RunLimits } from './limits.ts';
import type { ToolOffer } from './tool-offer.ts';
import type { ClaimTouched } from './touched-paths.ts';
import type { ToolLoading } from './tool-admission.ts';
import type { TokenPolicy } from './token-pin.ts';
import type { WorkerOptions } from './types.ts';

export type Flow = 'continue' | 'done';

export type Terminals = {
  finish(to: 'COMPLETED' | 'STOPPED' | 'FAILED', patch?: StatusPatch, preceding?: readonly RunEventPayload[]): Promise<'done'>;
  yieldTo(to: 'WAITING_HUMAN' | 'WAITING_TOOL' | 'QUEUED', availableAt?: number, options?: { refundAttempt?: true; awaits?: WaitTargets }): Promise<'done'>;
  cancel(): Promise<'done'>;
  yieldLease(): Promise<'done'>;
};

export type ClaimContext = {
  options: WorkerOptions;
  claim: Claim;
  run: Run;
  model: string;
  display: (model: string) => string;
  capabilities: Capabilities;
  toolLess: boolean;
  roles: ModelRoles;
  memoryShare?: number;
  guideline?: { version: number; text: string };
  limits: RunLimits;
  budget: BudgetAccount;
  delegation?: Delegation;
  toolSet: ToolSet;
  skills: SkillSet;
  recalled: MemorySet;
  touched: ClaimTouched;
  env: ToolEnv;
  functionTools(): FunctionTool[];
  toolOffer(loaded?: readonly string[]): ToolOffer;
  toolLoading?: ToolLoading;
  readers(): Readonly<Record<string, string>>;
  windowShared(): boolean;
  companions(): { hostOf: Readonly<Record<string, string>>; keepWithoutHost: boolean };
  systemPrompt: string;
  outputFit: OutputFit;
  reconcileFit: OutputFit;
  journal: Journal;
  control: ClaimControl;
  terminals: Terminals;
  agentSpan: TraceSpan;
  tracer: TracerPort;
  meter: TokenMeter;
  fallbackMeters: readonly TokenMeter[];
  counter: string;
  calibration: Calibration;
  targetFacts(target: string): Promise<{ meter: TokenMeter; capabilities: Capabilities; counter: string }>;
  pinnedDigest: { value: string | undefined };
  memory: RunMemory;
  completion: { conditions: readonly PinnedCondition[]; required: boolean };
  verificationCommands: readonly string[];
  autoCompact: boolean;
  token: TokenPolicy;
  policyFingerprint: string | undefined;
};

export type MeasuringWaits = { state: string; elapsedSeconds: number; stalls: number };

export type RunMemory = { streak: number; interruptions: number; deadlineAt: number; narrowingsNoticed: Set<string>; measuring?: MeasuringWaits };
