import type { TokenMeter } from '@momonga/context';
import type { Capabilities, FunctionTool } from '@momonga/protocol';
import type { Claim, Run, StatusPatch } from '@momonga/store';
import type { ToolSet } from '@momonga/tools';
import type { ToolEnv, TraceSpan } from '../ports.ts';
import type { ClaimControl } from './claim-control.ts';
import type { Journal } from './journal.ts';
import type { RunLimits } from './limits.ts';
import type { WorkerOptions } from './types.ts';

export type Flow = 'continue' | 'done';

export type Terminals = {
  finish(to: 'COMPLETED' | 'STOPPED' | 'FAILED', patch?: StatusPatch): 'done';
  yieldTo(to: 'WAITING_HUMAN' | 'QUEUED', availableAt?: number, options?: { refundAttempt: true }): 'done';
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
  env: ToolEnv;
  functionTools: FunctionTool[];
  systemPrompt: string;
  inlineLimit: number;
  journal: Journal;
  control: ClaimControl;
  terminals: Terminals;
  agentSpan: TraceSpan;
  meter: TokenMeter;
  pinnedDigest: { value: string | undefined };
  memory: RunMemory;
};

export type RunMemory = { streak: number; interruptions: number; deadlineAt: number };
