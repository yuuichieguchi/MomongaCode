import type { Clock, RolePort } from '@momonga/foundation';
import type { ContextOverflowError, InstructionReader } from '@momonga/context';
import type { RuntimeStore } from '@momonga/store';
import type { AgentsPort, GatewayPort, GovernancePort, HistoryPort, MemoryPort, RuleVerifierPort, SettingsPort, SkillsPort, ToolRuntimePort, TracerLeases } from '../ports.ts';
import type { ServiceTimers } from '../service/timers.ts';
import type { MandateRunVerification } from '../process/folder-verification.ts';
import type { SystemPromptContext } from '../system-prompt.ts';

export type WorkerDefaults = {
  maxSteps?: number;
  maxTotalTokens?: number;
  approvalTtlMs?: number;
  loopThreshold?: number;
};

export type WorkerBlobs = {
  handleFor(content: string): string;
  put(data: string, options: { mediaType: string; runId?: string }): Promise<{ handle: string }>;
  read(handle: string, range: { offset: number; length: number }, scope: { runId: string }): Promise<{ text: string; totalBytes: number }>;
};

export type WorkerErrorContext = { runId?: string; workerId: string };

export type WorkerWake = { subscribe(listener: () => void): () => void };

export type WorkerOptions = {
  store: RuntimeStore;
  gateway: GatewayPort;
  settings: SettingsPort;
  skills: SkillsPort;
  memories: MemoryPort;
  history: HistoryPort;
  governance: GovernancePort;
  agents?: AgentsPort;
  tools: ToolRuntimePort;
  ruleVerifier: RuleVerifierPort;
  mandateVerification: MandateRunVerification;
  tracers: TracerLeases;
  clock: Clock;
  workerId: string;
  role: RolePort;
  onClaimSettled?: () => void;
  leaseMs: number;
  heartbeatMs?: number;
  cancelPollMs?: number;
  idlePollMs?: number;
  defaults?: WorkerDefaults;
  systemPrompt?: (context: SystemPromptContext) => string;
  home: string;
  blobs: WorkerBlobs;
  instructionReaderFor(signal: AbortSignal): InstructionReader;
  onError?: (error: unknown, context: WorkerErrorContext) => void;
  onContextOverflow?: (error: ContextOverflowError) => void;
  onFatal: (error: Error) => void;
  wake?: WorkerWake;
  random: () => number;
  platform: string;
  timers: ServiceTimers;
};

export type Worker = {
  runOnce(): Promise<'idle' | 'yielded'>;
  start(): void;
  stop(): Promise<void>;
  abort(reason: 'shutdown'): Promise<void>;
  memorySize(): number;
  claimsInFlight(): number;
};
