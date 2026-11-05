export type ToolCallingMode = 'native' | 'constrained' | 'none';

export type ToolCallingState = ToolCallingMode | 'needs_probe';

export type NeedsProbe = { message: string; evidence: string; remedy: string };
export type ToolCallingSetting = 'native' | 'constrained' | 'auto';

export const TARGET_BILLINGS = ['metered', 'local'] as const;
export type TargetBilling = (typeof TARGET_BILLINGS)[number];

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

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const LOWEST_REASONING_EFFORT: ReasoningEffort = 'none';

export type ReasoningCapability =
  | { control: 'none'; headroomTokens?: number }
  | { control: 'reasoning_effort'; lowest: ReasoningEffort };

export const isReasoningEffort = (value: unknown): value is ReasoningEffort => REASONING_EFFORTS.some((effort) => effort === value);

export const reasoningEffortToSend = (requested: ReasoningEffort, lowest: ReasoningEffort): ReasoningEffort =>
  REASONING_EFFORTS.indexOf(requested) >= REASONING_EFFORTS.indexOf(lowest) ? requested : lowest;

export type PromptCacheCapability =
  | { kind: 'breakpoints'; maxBreakpoints: number }
  | { kind: 'key' }
  | { kind: 'automatic' }
  | { kind: 'none' };

export type CapabilitiesCore = {
  promptCache?: PromptCacheCapability;
  reasoning?: ReasoningCapability;
  contextWindow: number;
  maxOutputTokens: number;
  toolCalling: ToolCallingState;
  needsProbe?: NeedsProbe;
  structuredOutput: 'json_schema' | 'none';
  streaming: boolean;
  stopSequences: boolean;
  outputBoundField?: OutputBoundField;
  parallelToolCalls?: boolean;
  schemaDialect: 'json-schema-2020-12' | 'guided-generation';
  tokenCounting: 'exact' | 'calibrated' | 'estimated';
  tokenErrorRatio?: number;
  usageReported: boolean;
  maxConcurrency: number;
  source: 'declared' | 'probed' | 'config' | 'unprobed';
  probedAt?: string;
};

export type Capabilities = CapabilitiesCore & ImageCapability;

export type StructuredOutputVerdict = { ok: true } | { ok: false; reason: string };

export const requireStructuredOutput = (capabilities: Pick<Capabilities, 'structuredOutput'>, setting: string, alias: string): StructuredOutputVerdict =>
  capabilities.structuredOutput === 'json_schema'
    ? { ok: true }
    : { ok: false, reason: `${setting} names alias ${alias}, which has no structured output to hold the reply schema` };

export type CapabilityOverride = Partial<CapabilitiesCore> & { imageInput?: boolean; imageTokens?: ImageTokenModel | undefined };

export const applyCapabilityOverride = (declared: Capabilities, override: CapabilityOverride): Capabilities => {
  const { imageInput: declaredInput, imageTokens: declaredTokens, ...declaredCore } = declared;
  const { imageInput: overrideInput, imageTokens: overrideTokens, ...overrideCore } = override;
  const imageInput = overrideInput ?? declaredInput;
  const imageTokens = overrideTokens ?? (imageInput ? declaredTokens : undefined);
  const merged = { ...declaredCore, ...overrideCore, ...imageCapability(imageInput, imageTokens) };
  if (overrideCore.toolCalling === undefined) return merged;
  const { needsProbe: _answeredByOverride, ...answered } = merged;
  return answered;
};

export type HealthResult = {
  ok: boolean;
  reason?: 'not_running' | 'unhealthy' | 'precondition_failed' | 'health_check_failed';
  detail?: string;
  remediation?: string;
};
