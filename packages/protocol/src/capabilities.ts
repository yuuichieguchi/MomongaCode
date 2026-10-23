export type ToolCallingMode = 'native' | 'constrained' | 'none';
export type ToolCallingSetting = 'native' | 'constrained' | 'auto';

export type Capabilities = {
  contextWindow: number;
  maxOutputTokens: number;
  toolCalling: ToolCallingMode;
  structuredOutput: 'json_schema' | 'none';
  streaming: boolean;
  stopSequences: boolean;
  imageInput: boolean;
  parallelToolCalls: boolean;
  schemaDialect: 'json-schema-2020-12' | 'fm-generation';
  tokenCounting: 'exact' | 'calibrated' | 'estimated';
  usageReported: boolean;
  maxConcurrency: number;
  source: 'declared' | 'probed' | 'config' | 'unprobed';
  probedAt?: string;
};

export type HealthResult = {
  ok: boolean;
  reason?: 'not_running' | 'unhealthy' | 'precondition_failed' | 'health_check_failed';
  detail?: string;
  remediation?: string;
};
