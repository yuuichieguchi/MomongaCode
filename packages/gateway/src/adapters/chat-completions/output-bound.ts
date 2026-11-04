import type { OutputBoundField } from '@momonga/protocol';

export const outputBoundFor = (field: OutputBoundField, tokens: number): { max_tokens: number } | { max_completion_tokens: number } =>
  field === 'max_tokens' ? { max_tokens: tokens } : { max_completion_tokens: tokens };
