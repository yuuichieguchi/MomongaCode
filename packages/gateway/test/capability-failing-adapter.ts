import type { ProviderAdapter } from '@momonga/gateway';

export const capabilityFailingAdapter = (options: { inner: ProviderAdapter; fails: () => unknown }): ProviderAdapter => ({
  ...options.inner,
  capabilities: async () => {
    throw options.fails();
  },
  classify: (error) => ({
    retryable: false,
    error: { type: 'server_error', code: 'adapter_error', message: error instanceof Error ? error.message : String(error), param: null },
  }),
});
