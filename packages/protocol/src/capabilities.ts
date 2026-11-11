import type { DialectId } from './dialect.ts';
import { ERROR_TYPES } from './open-responses.ts';
import type { ErrorType } from './open-responses.ts';
import { CAPABILITIES_UNKNOWN_CODE, PLAN_STORE_STATES, SIGN_IN_REQUIRED_CODE } from './plan-api.ts';

export type ToolCallingMode = 'native' | 'constrained' | 'none';

export type NeedsProbe = { state: 'needs_probe'; message: string; evidence: string; remedy: string };

export type Probing = { state: 'probing'; message: string; retryAfterSeconds: number };

export type Unavailable = { state: 'unavailable'; status: number; type: ErrorType; code: string; message: string; param?: string };

export type ToolCallingState = ToolCallingMode | NeedsProbe | Probing | Unavailable;

export type ProbingCapabilities = { toolCalling: Probing; source: 'unprobed' };
export type UnavailableCapabilities = { toolCalling: Unavailable; source: 'unprobed' };
export type NotListedCapabilities = ProbingCapabilities | UnavailableCapabilities;
export type ToolCallingSetting = 'native' | 'constrained' | 'auto';

export const TARGET_BILLINGS = ['metered', 'local', 'plan'] as const;
export type TargetBilling = (typeof TARGET_BILLINGS)[number];

export const TARGET_ANSWERS = ['model', 'script'] as const;
export const UNKNOWN_ANSWERER = 'unknown' as const;
export type TargetAnswers = (typeof TARGET_ANSWERS)[number];

export type ImageTokenModel = { pixelsPerToken: number; maxTokens: number; minTokens: number };

export type ImageCapability =
  | { imageInput: false; imageTokens?: undefined }
  | { imageInput: true; imageTokens: ImageTokenModel };

export const imageCapability = (imageInput: boolean, imageTokens: ImageTokenModel | undefined, prefix = ''): ImageCapability => {
  if (!imageInput) {
    if (imageTokens !== undefined) throw new Error(`${prefix}capabilities.imageTokens is declared but capabilities.imageInput is false`);
    return { imageInput: false };
  }
  if (imageTokens === undefined) {
    throw new Error(
      `${prefix}capabilities.imageInput is true, so capabilities.imageTokens ({ pixelsPerToken, maxTokens, minTokens }) must declare how the target counts an image`,
    );
  }
  return { imageInput: true, imageTokens };
};

export const OUTPUT_BOUND_FIELDS = ['max_completion_tokens', 'max_tokens'] as const;
export type OutputBoundField = (typeof OUTPUT_BOUND_FIELDS)[number];

export const DEFAULT_OUTPUT_BOUND_FIELD: OutputBoundField = 'max_completion_tokens';

export const RESPONSES_OUTPUT_BOUNDS = ['max_output_tokens', 'none'] as const;

export const OUTPUT_BOUNDS = [...OUTPUT_BOUND_FIELDS, ...RESPONSES_OUTPUT_BOUNDS] as const;
export type OutputBound = (typeof OUTPUT_BOUNDS)[number];

export const DEFAULT_RESPONSES_OUTPUT_BOUND: OutputBound = 'max_output_tokens';

export const SYSTEM_ROLES = ['system', 'developer'] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

export const DEFAULT_SYSTEM_ROLE: SystemRole = 'system';

export const TOOL_PLACEMENTS = ['top_level', 'additional_tools'] as const;
export type ToolPlacement = (typeof TOOL_PLACEMENTS)[number];

export const DEFAULT_TOOL_PLACEMENT: ToolPlacement = 'top_level';

export const INPUT_CONTENT_KINDS = ['file', 'audio', 'video'] as const;
export type InputContentKind = (typeof INPUT_CONTENT_KINDS)[number];

export const REQUEST_TOOL_KINDS = [
  'function',
  'custom',
  'programmatic_tool_calling',
  'image_generation',
  'file_search',
  'code_interpreter',
  'computer_use',
  'mcp',
  'tool_search',
] as const;
export type RequestToolKind = (typeof REQUEST_TOOL_KINDS)[number];

export type InputKinds = { content: readonly InputContentKind[]; tools: readonly RequestToolKind[] };

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const LOWEST_REASONING_EFFORT: ReasoningEffort = 'none';

export const THINKING_OFFS = ['disabled', 'between_tools'] as const;
export type ThinkingOff = (typeof THINKING_OFFS)[number];

export type ThinkingBudgetEffort = Exclude<ReasoningEffort, 'none'>;
export type ThinkingAdaptiveEffort = Exclude<ThinkingBudgetEffort, 'minimal'>;

export type ReasoningCapability =
  | { control: 'none'; headroomTokens?: number }
  | { control: 'reasoning_effort'; lowest: ReasoningEffort }
  | { control: 'thinking'; form: 'adaptive'; efforts: readonly ThinkingAdaptiveEffort[]; off?: ThinkingOff }
  | { control: 'thinking'; form: 'budget'; budgets: Readonly<Partial<Record<ThinkingBudgetEffort, number>>>; off?: ThinkingOff };

export type ThinkingCapability = Extract<ReasoningCapability, { control: 'thinking' }>;

export const isReasoningEffort = (value: unknown): value is ReasoningEffort => REASONING_EFFORTS.some((effort) => effort === value);

const ladderOrder = (levels: readonly ReasoningEffort[]): ReasoningEffort[] => REASONING_EFFORTS.filter((level) => levels.includes(level));

export const acceptedReasoningEfforts = (capability: ReasoningCapability): ReasoningEffort[] => {
  switch (capability.control) {
    case 'none':
      return [];
    case 'reasoning_effort':
      return REASONING_EFFORTS.slice(REASONING_EFFORTS.indexOf(capability.lowest));
    case 'thinking': {
      const declared = capability.form === 'adaptive' ? capability.efforts : REASONING_EFFORTS.filter((level) => capability.budgets[level as ThinkingBudgetEffort] !== undefined);
      return ladderOrder([...(capability.off === undefined ? [] : ['none' as const]), ...declared]);
    }
  }
};

export const clampReasoningEffort = (requested: ReasoningEffort, accepted: readonly ReasoningEffort[]): ReasoningEffort => {
  if (requested === 'none' && accepted.includes('none')) return 'none';
  const ladder = ladderOrder(accepted).filter((level) => level !== 'none');
  const lowest = ladder[0];
  if (lowest === undefined) throw new Error('clampReasoningEffort needs at least one accepted ladder level');
  const rank = REASONING_EFFORTS.indexOf(requested);
  return ladder.findLast((level) => REASONING_EFFORTS.indexOf(level) <= rank) ?? lowest;
};

export type OutputTokenCapabilities = { maxOutputTokens: number; reasoning?: ReasoningCapability | undefined };

export const thinkingBudgetFor = (reasoning: ThinkingCapability, level: ReasoningEffort): number | undefined =>
  reasoning.form === 'budget' ? reasoning.budgets[level as ThinkingBudgetEffort] : undefined;

const reasoningTokensFor = (reasoning: ReasoningCapability | undefined, effort: ReasoningEffort | undefined): number => {
  if (effort === undefined || reasoning === undefined) return 0;
  if (reasoning.control === 'none') return reasoning.headroomTokens ?? 0;
  if (reasoning.control === 'thinking') return thinkingBudgetFor(reasoning, clampReasoningEffort(effort, acceptedReasoningEfforts(reasoning))) ?? 0;
  return 0;
};

export const outputTokensFor = (capabilities: OutputTokenCapabilities, effort: ReasoningEffort | undefined, visibleCap: number | undefined): number => {
  const { maxOutputTokens, reasoning } = capabilities;
  if (visibleCap === undefined) return maxOutputTokens;
  return Math.max(visibleCap, Math.min(maxOutputTokens, visibleCap + reasoningTokensFor(reasoning, effort)));
};

export type PromptCacheCapability =
  | { kind: 'breakpoints'; maxBreakpoints: number }
  | { kind: 'key' }
  | { kind: 'automatic' }
  | { kind: 'none' };

export const ALLOWED_TOOLS_FORMS = ['native', 'envelope', 'single_tool', 'filter'] as const;
export type AllowedToolsForm = (typeof ALLOWED_TOOLS_FORMS)[number];

export const SAMPLING_FIELDS = ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty'] as const;
export type SamplingField = (typeof SAMPLING_FIELDS)[number];

export type TopPRange = { min: number; max: number };

export type SamplingCapability =
  | { accepts: 'none' }
  | { accepts: 'without_thinking'; topP: TopPRange }
  | { accepts: 'free' };

export const ANTHROPIC_API_VERSIONS = ['2026-10-21', '2023-06-01'] as const;
export type AnthropicApiVersion = (typeof ANTHROPIC_API_VERSIONS)[number];

export const DEFAULT_ANTHROPIC_API_VERSION: AnthropicApiVersion = '2026-10-21';

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

const ANTHROPIC_VERSION_SAMPLING_BOUND: Readonly<Record<AnthropicApiVersion, readonly SamplingField[]>> = {
  '2026-10-21': [],
  '2023-06-01': SAMPLING_FIELDS,
};

export const anthropicVersionSamplingBound = (version: AnthropicApiVersion): readonly SamplingField[] => ANTHROPIC_VERSION_SAMPLING_BOUND[version];

export type AdapterSampling = {
  renders: readonly SamplingField[];
  bound?: { label: string; accepts: readonly SamplingField[] };
};

export type AdapterOutputBound = { renders: readonly OutputBound[] };

export type AdapterToolPlacement = { renders: readonly ToolPlacement[] };

export const JSON_MODES = ['json_object', 'none'] as const;

export type JsonMode = (typeof JSON_MODES)[number];

export type IdempotencyKeyCapability = { header: string };

export const IDEMPOTENCY_KEY_HEADER_PATTERN = "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$";

export type CapabilitiesCore = {
  promptCache?: PromptCacheCapability;
  sampling?: SamplingCapability;
  reasoning?: ReasoningCapability;
  contextWindow: number;
  maxOutputTokens: number;
  toolCalling: ToolCallingState;
  structuredOutput: 'json_schema' | 'none';
  jsonMode?: JsonMode;
  streaming: boolean;
  stopSequences: boolean;
  outputBoundField?: OutputBound;
  systemRole?: SystemRole;
  toolPlacement?: ToolPlacement;
  inputKinds?: InputKinds;
  parallelToolCalls?: boolean;
  allowedTools?: readonly AllowedToolsForm[];
  idempotencyKey?: IdempotencyKeyCapability;
  schemaDialect: DialectId;
  tokenCounting: 'exact' | 'calibrated' | 'estimated';
  tokenErrorRatio?: number;
  usageReported: boolean;
  maxConcurrency: number;
  source: 'declared' | 'probed' | 'config' | 'unprobed';
  probedAt?: string;
};

export type Capabilities = CapabilitiesCore & ImageCapability;

export type ChainCapabilities = Omit<Capabilities, 'schemaDialect'> & { schemaDialect?: DialectId; unboundedOutputTokens?: number };

export type CapabilityOverride = Partial<CapabilitiesCore> & { imageInput?: boolean; imageTokens?: ImageTokenModel | undefined };

export const applyCapabilityOverride = (declared: Capabilities, override: CapabilityOverride): Capabilities => {
  const { imageInput: declaredInput, imageTokens: declaredTokens, ...declaredCore } = declared;
  const { imageInput: overrideInput, imageTokens: overrideTokens, ...overrideCore } = override;
  const imageInput = overrideInput ?? declaredInput;
  const imageTokens = overrideTokens ?? (imageInput ? declaredTokens : undefined);
  return { ...declaredCore, ...overrideCore, ...imageCapability(imageInput, imageTokens) };
};

export const PRECONDITION_FAILED_CODE = 'precondition_failed';

export const CHAIN_ROOM_REFUSED_CODE = 'chain_room_refused';

export const MODEL_ID_CHANGED_CODE = 'model_id_changed';

export const MODEL_NOT_LISTED_CODE = 'model_not_listed';

export const TARGET_HEALTH_REASONS = ['not_running', 'unhealthy', PRECONDITION_FAILED_CODE, 'health_check_failed', SIGN_IN_REQUIRED_CODE, ...PLAN_STORE_STATES, CAPABILITIES_UNKNOWN_CODE] as const;
export type TargetHealthReason = (typeof TARGET_HEALTH_REASONS)[number];

export type HealthResult = { ok: boolean; reason?: TargetHealthReason; detail?: string; remediation?: string };

const TOOL_CALLING_MODES: readonly ToolCallingMode[] = ['native', 'constrained', 'none'];

const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

const isUnavailableFields = (record: Record<string, unknown>): boolean => {
  const { status, type, code, message, param } = record;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < MIN_HTTP_STATUS || status > MAX_HTTP_STATUS) return false;
  if (!ERROR_TYPES.some((known) => known === type)) return false;
  return typeof code === 'string' && typeof message === 'string' && (param === undefined || typeof param === 'string');
};

export const isToolCallingState = (value: unknown): value is ToolCallingState => {
  if (typeof value === 'string') return TOOL_CALLING_MODES.some((mode) => mode === value);
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['state'] === 'probing') return typeof record['message'] === 'string' && typeof record['retryAfterSeconds'] === 'number';
  if (record['state'] === 'unavailable') return isUnavailableFields(record);
  return record['state'] === 'needs_probe' && typeof record['message'] === 'string' && typeof record['evidence'] === 'string' && typeof record['remedy'] === 'string';
};

export const TARGET_NOT_READY = 'target_not_ready';

export const NO_MODEL_TARGET = 'no model target is set up';

export const startModelOf = (listed: { count: number; start: string | null }): string | undefined => (listed.count === 0 || listed.start === null ? undefined : listed.start);

export type Readiness =
  | { state: 'ready' }
  | { state: 'no_tools'; message: string }
  | { state: 'needs_probe'; message: string; evidence: string; remedy: string }
  | Probing
  | { state: 'unavailable'; message: string };

export type ReadinessInput = ({ toolCalling: ToolCallingState; unavailable?: undefined } & Partial<Omit<CapabilitiesCore, 'toolCalling'>>) | { unavailable: string };

const NO_TOOLS_MESSAGE = 'This model cannot call tools. MomongaCode will answer without reading or changing files.';

export const REMEDY_SURFACES = ['tui', 'shell'] as const;
export type RemedySurface = (typeof REMEDY_SURFACES)[number];

const READINESS_REMEDIES: Readonly<Record<'no_tools' | 'unavailable', Readonly<Record<RemedySurface, string>>>> = {
  no_tools: {
    tui: 'For coding work, choose another model with /model; /models add lists the local servers that are running.',
    shell: 'For coding work, choose another model with momonga --model <model>; momonga models detect lists the local servers that are running.',
  },
  unavailable: {
    tui: 'Choose a model with /model, or set one up with /models add.',
    shell: 'Choose a model with momonga --model <model>, or set one up with momonga models add.',
  },
};

export const readinessRemedy = (state: 'no_tools' | 'unavailable', surface: RemedySurface): string => READINESS_REMEDIES[state][surface];

export function agentReadiness(input: { unavailable: string }): Extract<Readiness, { state: 'unavailable' }>;
export function agentReadiness(input: ReadinessInput): Readiness;
export function agentReadiness(input: ReadinessInput): Readiness {
  if (input.unavailable !== undefined) return { state: 'unavailable', message: input.unavailable };
  const { toolCalling } = input;
  if (typeof toolCalling !== 'string') {
    if (toolCalling.state === 'probing') return { state: 'probing', message: toolCalling.message, retryAfterSeconds: toolCalling.retryAfterSeconds };
    if (toolCalling.state === 'unavailable') return { state: 'unavailable', message: toolCalling.message };
    return { state: 'needs_probe', message: toolCalling.message, evidence: toolCalling.evidence, remedy: toolCalling.remedy };
  }
  return toolCalling === 'none' ? { state: 'no_tools', message: NO_TOOLS_MESSAGE } : { state: 'ready' };
}

export const isProbingCapabilities = (capabilities: { toolCalling: ToolCallingState }): capabilities is ProbingCapabilities => agentReadiness({ toolCalling: capabilities.toolCalling }).state === 'probing';

export const isUnavailableCapabilities = (capabilities: { toolCalling: ToolCallingState }): capabilities is UnavailableCapabilities =>
  typeof capabilities.toolCalling === 'object' && capabilities.toolCalling.state === 'unavailable';

export const isNotListedCapabilities = (capabilities: { toolCalling: ToolCallingState }): capabilities is NotListedCapabilities =>
  isUnavailableCapabilities(capabilities) || isProbingCapabilities(capabilities);

export const notListedMessage = (capabilities: NotListedCapabilities): string => capabilities.toolCalling.message;

export const readinessText = (readiness: Exclude<Readiness, { state: 'ready' }>): string => ('remedy' in readiness ? [readiness.message, readiness.remedy].join('\n') : readiness.message);

export const readinessShownText = (readiness: Exclude<Readiness, { state: 'ready' }>, surface: RemedySurface): string =>
  readiness.state === 'no_tools' || readiness.state === 'unavailable' ? [readiness.message, readinessRemedy(readiness.state, surface)].join('\n') : readinessText(readiness);

export const readinessRemedyOf = (text: string): string => text.split('\n').at(-1) ?? text;

export const maxOutputTokensFor = (contextWindow: number): number => Math.min(contextWindow, Math.max(256, Math.ceil(contextWindow / 4)));
