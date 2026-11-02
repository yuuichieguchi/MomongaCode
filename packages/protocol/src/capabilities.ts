export type ToolCallingMode = 'native' | 'constrained' | 'none';
export type ToolCallingSetting = 'native' | 'constrained' | 'auto';

export type ImageTokenModel = { pixelsPerToken: number; maxTokens: number };

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
      `${prefix}capabilities.imageInput is true, so capabilities.imageTokens ({ pixelsPerToken, maxTokens }) must declare how the target counts an image`,
    );
  }
  return { imageInput: true, imageTokens };
};

export type CapabilitiesCore = {
  contextWindow: number;
  maxOutputTokens: number;
  toolCalling: ToolCallingMode;
  structuredOutput: 'json_schema' | 'none';
  streaming: boolean;
  stopSequences: boolean;
  parallelToolCalls: boolean;
  schemaDialect: 'json-schema-2020-12' | 'guided-generation';
  tokenCounting: 'exact' | 'calibrated' | 'estimated';
  tokenErrorRatio?: number;
  usageReported: boolean;
  maxConcurrency: number;
  source: 'declared' | 'probed' | 'config' | 'unprobed';
  probedAt?: string;
};

export type Capabilities = CapabilitiesCore & ImageCapability;

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
  reason?: 'not_running' | 'unhealthy' | 'precondition_failed' | 'health_check_failed';
  detail?: string;
  remediation?: string;
};
