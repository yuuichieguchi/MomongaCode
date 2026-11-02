import type { Clock } from '@momonga/foundation';
import type { InstructionReader } from '@momonga/context';
import type { RuntimeStore } from '@momonga/store';
import type { AgentsPort, GatewayPort, HistoryPort, MemoryPort, SettingsPort, SkillsPort, ToolRuntimePort, TracerPort } from '../ports.ts';
import type { ServiceTimers } from '../service/timers.ts';
import type { SystemPromptContext } from '../system-prompt.ts';

export type WorkerDefaults = {
  maxSteps?: number;
  maxTotalTokens?: number;
  approvalTtlMs?: number;
  loopThreshold?: number;
};

export type WorkerBlobs = {
  handleFor(content: string): string;
  put(data: string, options: { mediaType: string; runId?: string }): { handle: string };
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
  agents?: AgentsPort;
  tools: ToolRuntimePort;
  tracer: TracerPort;
  clock: Clock;
  workerId: string;
  leaseMs: number;
  heartbeatMs?: number;
  cancelPollMs?: number;
  idlePollMs?: number;
  defaults?: WorkerDefaults;
  systemPrompt?: (context: SystemPromptContext) => string;
  home: string;
  blobs: WorkerBlobs;
  instructionReader: InstructionReader;
  onError?: (error: unknown, context: WorkerErrorContext) => void;
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
};
