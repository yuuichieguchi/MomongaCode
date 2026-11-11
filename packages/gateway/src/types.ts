import type { Clock, RolePort, StopValues, KernelLockMechanism } from '@momonga/foundation';
import type { PriceTable, Telemetry } from '@momonga/observability';
import type { PlanApi } from './plan/api.ts';
import type { GatewayEpochs } from './core/services.ts';
import type { ReasoningOriginCodec } from './core/reasoning-origin.ts';
import type { Redactor } from './core/redaction.ts';
import type { BilledCallsCursorView, BilledCallsPageView, CapabilityOverride, GatewayCostReportView, MomongaModelRoles, PlanAccountRef, ProviderAdapter, TargetAnswers, TargetBilling, TraceContentPage } from '@momonga/protocol';

export type GatewayTargetConfig = {
  kind: string;
  provider: string;
  model: string;
  defaultTag?: string;
  answers?: TargetAnswers;
  billing: TargetBilling;
  maxConcurrency: number;
  admissionTimeoutMs: number;
  counter: string;
  idempotencyKeyHeader?: string;
  capabilities?: CapabilityOverride;
  plan?: PlanAccountRef;
  keyGroup?: string;
};

export type GatewayBillingChange = { from: TargetBilling; to: TargetBilling; model?: string };

export type GatewayConfig = {
  models: {
    targets: Record<string, GatewayTargetConfig>;
    chains: Record<string, string[]>;
    billingChanges?: readonly GatewayBillingChange[];
    start?: string;
    roles?: MomongaModelRoles;
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
  timeoutSignal(ms: number): AbortSignal;
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
  lock: KernelLockMechanism;
  costReport?: (runs: readonly { runId: string; sessionId: string }[], includeRunless: boolean, signal: AbortSignal) => Promise<{ report: GatewayCostReportView; text: string }>;
  billedCalls?: (runIds: readonly string[], cursor: BilledCallsCursorView, limit: number, includeRunless: boolean, signal: AbortSignal) => Promise<BilledCallsPageView>;
  traceContent?: (runId: string, after: number, limit: number, signal: AbortSignal) => Promise<TraceContentPage>;
  debugTcp?: DebugTcpOptions;
  random: () => number;
  pid: number;
  version: string;
  onError?: (error: unknown) => void;
  plan?: PlanApi;
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
