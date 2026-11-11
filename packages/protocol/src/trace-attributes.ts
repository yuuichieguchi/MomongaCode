import type { StoredRenames } from './stored-names.ts';

export const MOMONGA_ATTRIBUTES = {
  runId: 'momonga.run_id',
  step: 'momonga.step',
  attempt: 'momonga.attempt',
  retryOf: 'momonga.retry_of',
  billing: 'momonga.billing',
  usageSource: 'momonga.usage_source',
  target: 'momonga.target',
  role: 'momonga.role',
  failureMessage: 'momonga.failure_message',
  fallbackCauses: 'momonga.fallback_causes',
  toolBackendSource: 'tool.backend.source',
  toolBackendVersion: 'tool.backend.version',
} as const;

export const SPAN_ATTRIBUTE_RENAMES: StoredRenames = {
  'momonga.usage.cache_write_input_tokens': 'gen_ai.usage.cache_creation.input_tokens',
};

export const ERROR_TYPE_ATTRIBUTE = 'error.type';

export const MOMONGA_EVENTS = {
  responseCommitted: 'momonga.response.committed',
} as const;

export const MOMONGA_SPAN_NOTES = {
  adapterCleanupError: 'momonga.adapter_cleanup_error',
} as const;

export const MOMONGA_REQUEST_FIELDS = {
  target: 'momonga.target',
  exactModel: 'momonga.exact_model',
  maxSummaryTokens: 'momonga.max_summary_tokens',
  maxCostNano: 'momonga.max_cost_nano',
  maxInputTokens: 'momonga.max_input_tokens',
} as const;
