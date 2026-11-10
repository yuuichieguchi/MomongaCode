import type { Clock, RolePort, StopValues } from '@momonga/foundation';
import type { PriceTable, Telemetry } from '@momonga/observability';
import type { GatewayEpochs } from './core/services.ts';
import type { ReasoningOriginCodec } from './core/reasoning-origin.ts';
import type { Redactor } from './core/redaction.ts';
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

export type GatewayEpochsShared = { redactor: Redactor; reasoningOrigin: ReasoningOriginCodec };

export type GatewayLimits = Omit<GatewayConfig, 'models'>;

export type FixedModelsOptions = { config: GatewayConfig; adapters: Record<string, ProviderAdapter>; priceTable?: PriceTable; telemetry?: Telemetry };

export type DerivedModelsOptions = { limits: GatewayLimits; epochs: GatewayEpochs } & GatewayEpochsShared;

export type GatewayOptions = GatewayCommonOptions & (FixedModelsOptions | DerivedModelsOptions);

export type GatewayCommonOptions = {
  startSignal?: AbortSignal;
  role: RolePort;
  probeFlights?: () => number;
  credentials: readonly string[];
  credentialFeed?: (add: (credential: string) => void) => void;
  clock: Clock;
  timers: GatewayTimers;
  dbPath: string;
  hmacKey: Uint8Array;
  socketPath: string;
  costReport?: (runs: readonly { runId: string; sessionId: string }[], includeRunless: boolean, signal: AbortSignal) => Promise<{ report: GatewayCostReportView; text: string }>;
  billedCalls?: (runIds: readonly string[], cursor: BilledCallsCursorView, limit: number, includeRunless: boolean, signal: AbortSignal) => Promise<BilledCallsPageView>;
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
  activeRequests(): number;
  releaseIdleConnections(): void;
  close(values?: StopValues): Promise<void>;
  abort(values?: StopValues): Promise<void>;
};
