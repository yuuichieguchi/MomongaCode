import type { DialectId } from './dialect.ts';

export type ToolCallingMode = 'native' | 'constrained' | 'none';

export type NeedsProbe = { state: 'needs_probe'; message: string; evidence: string; remedy: string };

export type Probing = { state: 'probing'; message: string; retryAfterSeconds: number };

export type ToolCallingState = ToolCallingMode | NeedsProbe | Probing;

export type ProbingCapabilities = { toolCalling: Probing; source: 'unprobed' };
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

export const INPUT_CONTENT_KINDS = ['text', 'image', 'file', 'audio', 'video'] as const;
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
  schemaDialect: DialectId;
  tokenCounting: 'exact' | 'calibrated' | 'estimated';
  tokenErrorRatio?: number;
  usageReported: boolean;
  maxConcurrency: number;
  source: 'declared' | 'probed' | 'config' | 'unprobed';
  probedAt?: string;
};

export type Capabilities = CapabilitiesCore & ImageCapability;

export type AliasCapabilities = Omit<Capabilities, 'schemaDialect'> & { schemaDialect?: DialectId; unboundedOutputTokens?: number };

export type CapabilityOverride = Partial<CapabilitiesCore> & { imageInput?: boolean; imageTokens?: ImageTokenModel | undefined };

export const applyCapabilityOverride = (declared: Capabilities, override: CapabilityOverride): Capabilities => {
  const { imageInput: declaredInput, imageTokens: declaredTokens, ...declaredCore } = declared;
  const { imageInput: overrideInput, imageTokens: overrideTokens, ...overrideCore } = override;
  const imageInput = overrideInput ?? declaredInput;
  const imageTokens = overrideTokens ?? (imageInput ? declaredTokens : undefined);
  return { ...declaredCore, ...overrideCore, ...imageCapability(imageInput, imageTokens) };
};

export type HealthResult = {
  ok: boolean;
  reason?: 'not_running' | 'unhealthy' | 'precondition_failed' | 'health_check_failed' | 'sign_in_required' | 'store_unreadable' | 'store_unwritable' | 'capabilities_unknown';
  detail?: string;
  remediation?: string;
};

export const PRECONDITION_FAILED_CODE = 'precondition_failed';

const TOOL_CALLING_MODES: readonly ToolCallingMode[] = ['native', 'constrained', 'none'];

export const isToolCallingState = (value: unknown): value is ToolCallingState => {
  if (typeof value === 'string') return TOOL_CALLING_MODES.some((mode) => mode === value);
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['state'] === 'probing') return typeof record['message'] === 'string' && typeof record['retryAfterSeconds'] === 'number';
  return record['state'] === 'needs_probe' && typeof record['message'] === 'string' && typeof record['evidence'] === 'string' && typeof record['remedy'] === 'string';
};

export const TARGET_NOT_READY = 'target_not_ready';

export const NO_MODEL_TARGET = 'no model target is set up';

export type Readiness =
  | { state: 'ready' }
  | { state: 'no_tools'; message: string; remedy: string }
  | { state: 'needs_probe'; message: string; evidence: string; remedy: string }
  | Probing
  | { state: 'unavailable'; message: string; remedy: string };

export type ReadinessInput = ({ toolCalling: ToolCallingState; unavailable?: undefined } & Partial<Omit<CapabilitiesCore, 'toolCalling'>>) | { unavailable: string };

const NO_TOOLS_MESSAGE = 'This model cannot call tools. MomongaCode will answer without reading or changing files.';

const NO_TOOLS_REMEDY = 'For coding work, choose another model with /model; /models detect lists the local servers that are running.';

const UNAVAILABLE_REMEDY = 'Choose a model with /model, or set one up with /models detect.';

export function agentReadiness(input: { unavailable: string }): Extract<Readiness, { state: 'unavailable' }>;
export function agentReadiness(input: ReadinessInput): Readiness;
export function agentReadiness(input: ReadinessInput): Readiness {
  if (input.unavailable !== undefined) return { state: 'unavailable', message: input.unavailable, remedy: UNAVAILABLE_REMEDY };
  const { toolCalling } = input;
  if (typeof toolCalling !== 'string') {
    if (toolCalling.state === 'probing') return { state: 'probing', message: toolCalling.message, retryAfterSeconds: toolCalling.retryAfterSeconds };
    return { state: 'needs_probe', message: toolCalling.message, evidence: toolCalling.evidence, remedy: toolCalling.remedy };
  }
  return toolCalling === 'none' ? { state: 'no_tools', message: NO_TOOLS_MESSAGE, remedy: NO_TOOLS_REMEDY } : { state: 'ready' };
}

export const isProbingCapabilities = (capabilities: { toolCalling: ToolCallingState }): capabilities is ProbingCapabilities => agentReadiness({ toolCalling: capabilities.toolCalling }).state === 'probing';

export const readinessText = (readiness: Exclude<Readiness, { state: 'ready' }>): string => ('remedy' in readiness ? [readiness.message, readiness.remedy].join('\n') : readiness.message);

export const readinessRemedyOf = (text: string): string => text.split('\n').at(-1) ?? text;
