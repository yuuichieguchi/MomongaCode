import type { ErrorShape } from './budget-constants.ts';
import type { Capabilities, ChainCapabilities, HealthResult, ProbingCapabilities, TargetAnswers, TargetBilling, UnavailableCapabilities } from './capabilities.ts';
import type { FunctionTool, InputItem, ToolChoice } from './open-responses.ts';
import type { PlanAccountRef } from './plan-account.ts';

export const MOMONGA_EVENT_PREFIX = 'momonga:' as const;

export type MomongaEventName = `${typeof MOMONGA_EVENT_PREFIX}${string}`;

export type CountTokensMethod = 'exact' | 'calibrated' | 'estimated';

export type CountTokensMomongaExtension = {
  lenient_items?: { call_names: Record<string, string>; with_tools: boolean };
  target?: string;
  exact_model?: boolean;
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
  models: Record<string, TargetHealth>;
  version: string;
  apiVersion: 1;
  pid: number;
  startedAt: string;
  state: 'running' | 'retiring' | 'draining';
  activeRequests: number;
};

export type UsageSource = 'reported' | 'estimated';

export type ModelListEntry = { id: string; object: 'model'; created: number; owned_by: string };

export type ModelList = { object: 'list'; data: ModelListEntry[] };

export const TARGET_PROBING = 'target_probing';

export const TARGET_PROBE_FAILED = 'target_probe_failed';

export const SERVICE_UNAVAILABLE_STATUS = 503;

export const isTargetProbing = (answer: { status: number; code: string | null }): boolean => answer.status === SERVICE_UNAVAILABLE_STATUS && answer.code === TARGET_PROBING;

export const TARGET_PROBING_MESSAGE = 'measuring this model (once per model and OS build)';

export type ChainMemberEntry = {
  model: string;
  counter: string;
  billing: TargetBilling;
  provider?: string;
  adapter: string;
  answers: TargetAnswers;
  upstream: string;
  plan?: PlanAccountRef;
  key?: { group: string };
  capabilities: Capabilities | ProbingCapabilities | UnavailableCapabilities;
};

export type MomongaModelEntry = {
  id: string;
  object: 'model';
  provider: string;
  ownName: string;
  defaultTag?: string;
  billing: TargetBilling;
  capabilities: ChainCapabilities | ProbingCapabilities | UnavailableCapabilities;
  chain: ChainMemberEntry[];
};

export type MomongaModelRoles = { compaction?: string; reflection?: string; analysis?: string };

export type MomongaModelList = { object: 'list'; data: MomongaModelEntry[]; start: string | null; roles: MomongaModelRoles };
