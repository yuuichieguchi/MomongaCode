import type { ProviderAdapter } from '@momonga/protocol';
import { PreconditionFailedError } from './shared/failures.ts';
import { RENDERS_EVERY_SAMPLING_FIELD } from './shared/sampling.ts';

export const createUnservedAdapter = (reason: string): ProviderAdapter => {
  const refusal = (): PreconditionFailedError => new PreconditionFailedError(reason, reason, undefined);
  return {
    kind: 'unserved',
    sampling: RENDERS_EVERY_SAMPLING_FIELD,
    relaysClientBody: [],
    capabilities: async () => {
      throw refusal();
    },
    create: () => {
      throw refusal();
    },
    classify: () => ({ retryable: false, error: { message: reason, type: 'invalid_request', code: 'target_not_ready', param: null } }),
    toolChoiceWire: () => {
      throw refusal();
    },
  };
};
