import type { Clock } from '@momonga/foundation';
import type { InstructionReader } from '@momonga/context';
import type { RuntimeStore } from '@momonga/store';
import type { GatewayPort, SettingsPort, ToolRuntimePort, TracerPort } from '../ports.ts';
import type { SystemPromptContext } from '../system-prompt.ts';

export type WorkerDefaults = {
  maxSteps?: number;
  maxTotalTokens?: number;
  approvalTtlMs?: number;
  loopThreshold?: number;
};

export type WorkerBlobs = {
  put(data: string, options: { mediaType: string }): { handle: string };
};

export type WorkerErrorContext = { runId?: string; workerId: string };

export type WorkerOptions = {
  store: RuntimeStore;
  gateway: GatewayPort;
  settings: SettingsPort;
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
};

export type Worker = {
  runOnce(): Promise<'idle' | 'yielded'>;
  start(): void;
  stop(): Promise<void>;
};
