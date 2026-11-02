import type { Clock } from '@momonga/foundation';
import type { Telemetry } from '@momonga/observability';
import type { Capabilities, CostReportView, ProviderAdapter } from '@momonga/protocol';

export type GatewayTargetConfig = {
  kind: string;
  provider: string;
  model: string;
  maxConcurrency: number;
  admissionTimeoutMs: number;
  capabilities?: Partial<Capabilities>;
};

export type GatewayConfig = {
  models: {
    aliases: Record<string, string[]>;
    targets: Record<string, GatewayTargetConfig>;
  };
  retry: { maxAttempts: number; baseMs: number; maxMs: number };
  breaker: { failureThreshold: number; openMs: number };
  limits: { maxBodyBytes: number; maxIdempotencyFrameBytes: number; readerStallMs: number };
  idempotency: { ttlMs: number };
  closeGraceMs: number;
  sseKeepAliveMs: number;
  detachedMaxMs: number;
  websocketConnectionMs: number;
};

export type GatewayTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type DebugTcpOptions = { host: string; port: number; token: string };

export type GatewayOptions = {
  config: GatewayConfig;
  adapters: Record<string, ProviderAdapter>;
  credentials: readonly string[];
  credentialFeed?: (add: (credential: string) => void) => void;
  clock: Clock;
  timers: GatewayTimers;
  dbPath: string;
  hmacKey: Uint8Array;
  socketPath: string;
  telemetry?: Telemetry;
  costReport?: (runs: readonly { runId: string; sessionId: string }[]) => Promise<{ report: CostReportView; text: string }>;
  debugTcp?: DebugTcpOptions;
  random: () => number;
  version: string;
  onError?: (error: unknown) => void;
  onFatal?: (error: Error) => void;
};

export type Gateway = {
  readonly socketPath: string;
  readonly startedAt: string;
  readonly tcpPort: number | undefined;
  readonly abandonedRuns: number;
  addCredential(credential: string): void;
  close(): Promise<void>;
  abort(): Promise<void>;
};
