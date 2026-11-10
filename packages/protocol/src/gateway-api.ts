import type { ErrorShape } from './budget-constants.ts';
import type { AliasCapabilities, Capabilities, HealthResult, ProbingCapabilities, TargetBilling, UnavailableCapabilities } from './capabilities.ts';
import type { FunctionTool, InputItem, ToolChoice } from './open-responses.ts';

export const MOMONGA_EVENT_PREFIX = 'momonga:' as const;

export type MomongaEventName = `${typeof MOMONGA_EVENT_PREFIX}${string}`;

export type CountTokensMethod = 'exact' | 'calibrated' | 'estimated';

export type CountTokensMomongaExtension = {
  lenient_items?: { call_names: Record<string, string>; with_tools: boolean };
  target?: string;
};

export type CountTokensRequest = {
  model: string;
  input: string | InputItem[];
  instructions?: string | null;
  tools?: FunctionTool[];
  tool_choice?: ToolChoice;
  momonga?: CountTokensMomongaExtension;
};

export type CountTokensResult = {
  input_tokens: number;
  method: CountTokensMethod;
  error_bound: number;
  error_shape: ErrorShape;
};

export type TargetHealth = {
  ok: boolean;
  breaker: 'closed' | 'open' | 'half-open';
  reason?: HealthResult['reason'];
  detail?: string;
  remediation?: string;
};

export type GatewayHealth = {
  ok: boolean;
  targets: Record<string, TargetHealth>;
  version: string;
  apiVersion: 1;
  pid: number;
  startedAt: string;
  state: 'running' | 'draining';
};

export type UsageSource = 'reported' | 'estimated';

export type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type UsageReportResponse = {
  response_id: string;
  step: number | null;
  target: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  usage_source: UsageSource;
};

export type UsageReportStep = {
  step: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type UsageReport = {
  run_id: string;
  responses: UsageReportResponse[];
  steps: UsageReportStep[];
  total: UsageTotals;
};

export type ModelListEntry = { id: string; object: 'model'; created: number; owned_by: string };

export type ModelList = { object: 'list'; data: ModelListEntry[] };

export const TARGET_PROBING = 'target_probing';

export const TARGET_PROBING_MESSAGE = 'measuring this model (once per model and OS build)';

export type MomongaModelEntry = {
  id: string;
  object: 'model';
  targets: string[];
  targetCounters: Record<string, string>;
  capabilities: AliasCapabilities | ProbingCapabilities | UnavailableCapabilities;
  targetCapabilities: Record<string, Capabilities | ProbingCapabilities | UnavailableCapabilities>;
  targetBilling?: Record<string, TargetBilling>;
  targetPlan?: Record<string, { profile: string; account?: string }>;
  targetKey?: Record<string, { group: string }>;
};

export type MomongaModelList = { object: 'list'; data: MomongaModelEntry[] };
