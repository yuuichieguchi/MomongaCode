export const MOMONGA_ATTRIBUTES = {
  runId: 'momonga.run_id',
  step: 'momonga.step',
  attempt: 'momonga.attempt',
  billing: 'momonga.billing',
  cacheWriteInputTokens: 'momonga.usage.cache_write_input_tokens',
  target: 'momonga.target',
  role: 'momonga.role',
  failureMessage: 'momonga.failure_message',
  fallbackCauses: 'momonga.fallback_causes',
  toolBackendSource: 'tool.backend.source',
  toolBackendVersion: 'tool.backend.version',
} as const;

export const ERROR_TYPE_ATTRIBUTE = 'error.type';

export const MOMONGA_EVENTS = {
  responseCommitted: 'momonga.response.committed',
} as const;

export const MOMONGA_SPAN_NOTES = {
  adapterCleanupError: 'momonga.adapter_cleanup_error',
} as const;

export const MOMONGA_REQUEST_FIELDS = {
  target: 'momonga.target',
  maxSummaryTokens: 'momonga.max_summary_tokens',
} as const;
