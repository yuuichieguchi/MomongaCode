import type { Capabilities, HealthResult } from './capabilities.ts';
import type { FunctionTool, InputItem } from './open-responses.ts';

export const MOMONGA_EVENT_PREFIX = 'momonga:' as const;

export type MomongaEventName = `${typeof MOMONGA_EVENT_PREFIX}${string}`;

export type CountTokensMethod = 'exact' | 'calibrated' | 'estimated';

export type CountTokensRequest = {
  model: string;
  input: string | InputItem[];
  instructions?: string | null;
  tools?: FunctionTool[];
};

export type CountTokensResult = {
  input_tokens: number;
  method: CountTokensMethod;
  error_bound: number;
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

export type MomongaModelEntry = {
  id: string;
  object: 'model';
  targets: string[];
  capabilities: Capabilities;
};

export type MomongaModelList = { object: 'list'; data: MomongaModelEntry[] };
