import type { TokenMeter } from '@momonga/context';
import type { Capabilities, FunctionTool } from '@momonga/protocol';
import type { SkillSet } from '@momonga/skills';
import type { Claim, Run, StatusPatch, WaitTargets } from '@momonga/store';
import type { ToolSet } from '@momonga/tools';
import type { ToolEnv, TraceSpan } from '../ports.ts';
import type { ClaimControl } from './claim-control.ts';
import type { Journal } from './journal.ts';
import type { RunLimits } from './limits.ts';
import type { WorkerOptions } from './types.ts';

export type Flow = 'continue' | 'done';

export type Terminals = {
  finish(to: 'COMPLETED' | 'STOPPED' | 'FAILED', patch?: StatusPatch): 'done';
  yieldTo(to: 'WAITING_HUMAN' | 'WAITING_TOOL' | 'QUEUED', availableAt?: number, options?: { refundAttempt?: true; awaits?: WaitTargets }): 'done';
  cancel(): 'done';
  yieldLease(): 'done';
};

export type ClaimContext = {
  options: WorkerOptions;
  claim: Claim;
  run: Run;
  alias: string;
  capabilities: Capabilities;
  limits: RunLimits;
  toolSet: ToolSet;
  skills: SkillSet;
  env: ToolEnv;
  functionTools(): FunctionTool[];
  systemPrompt: string;
  inlineLimitForReconcile: number;
  inlineLimitForExecution: () => Promise<number>;
  journal: Journal;
  control: ClaimControl;
  terminals: Terminals;
  agentSpan: TraceSpan;
  meter: TokenMeter;
  pinnedDigest: { value: string | undefined };
  memory: RunMemory;
  compaction: { suppressedUntilStep: number };
};

export type RunMemory = { streak: number; interruptions: number; deadlineAt: number };
