import type { Capabilities } from '@momonga/protocol';

export const outputBoundOf = (capabilities: Pick<Capabilities, 'outputBoundField'>, tokens: number): { max_output_tokens?: number } =>
  capabilities.outputBoundField === 'none' ? {} : { max_output_tokens: tokens };
