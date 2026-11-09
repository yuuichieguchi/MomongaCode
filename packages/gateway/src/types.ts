import type { Clock, StopValues } from '@momonga/foundation';
import type { PriceTable, Telemetry } from '@momonga/observability';
import type { BilledCallsCursorView, BilledCallsPageView, CapabilityOverride, GatewayCostReportView, ProviderAdapter, TargetBilling } from '@momonga/protocol';

export type GatewayTargetConfig = {
  kind: string;
  provider: string;
  model: string;
  billing: TargetBilling;
  maxConcurrency: number;
  admissionTimeoutMs: number;
  counter: string;
  capabilities?: CapabilityOverride;
};

export type GatewayConfig = {
  models: {
    aliases: Record<string, string[]>;
    targets: Record<string, GatewayTargetConfig>;
  };
  retry: { maxAttempts: number; totalWaitMs: number; baseMs: number; maxMs: number };
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
  priceTable?: PriceTable;
  costReport?: (runs: readonly { runId: string; sessionId: string }[], includeRunless: boolean) => Promise<{ report: GatewayCostReportView; text: string }>;
  billedCalls?: (runIds: readonly string[], cursor: BilledCallsCursorView, limit: number, includeRunless: boolean) => Promise<BilledCallsPageView>;
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
  close(values?: StopValues): Promise<void>;
  abort(values?: StopValues): Promise<void>;
};
