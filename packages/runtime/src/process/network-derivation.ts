import { createPinnedDerivation, derivedInputsOf, resolveNetwork, settingsInputsDigest } from '@momonga/config';
import type { UserSettingsCache } from '@momonga/config';
import { trustFailureText } from '@momonga/foundation';
import type { NetworkConfig, OutboundNetwork, TrustReport } from '@momonga/foundation';

export type DerivedNetwork = { readonly outbound: OutboundNetwork; readonly identity: string };

export type NetworkOf = (signal: AbortSignal) => Promise<DerivedNetwork>;

export type NetworkDerivationOptions = {
  cache: Pick<UserSettingsCache, 'loadOrKeep'>;
  signal: AbortSignal;
  env: Readonly<Record<string, string | undefined>>;
  install(config: NetworkConfig, signal: AbortSignal): Promise<TrustReport>;
  onWarning(message: string): void;
};

export type NetworkDerivation = { networkOf: NetworkOf };

export const createNetworkDerivation = ({ cache, signal, env, install, onWarning }: NetworkDerivationOptions): NetworkDerivation => {
  const derivation = createPinnedDerivation<DerivedNetwork>({
    cache,
    signal,
    inputsOf: derivedInputsOf('D4'),
    derive: async (settings, _previous, deriveSignal, inputs) => {
      const config = resolveNetwork(settings.network, env);
      const trust = await install(config, deriveSignal);
      for (const failure of trust.failures) onWarning(trustFailureText(failure));
      return { outbound: { config, trust }, identity: settingsInputsDigest(inputs) };
    },
    retire: () => undefined,
    onWarning,
  });
  return {
    networkOf: async (askSignal) => {
      const lease = await derivation.acquire(askSignal);
      lease.release();
      return lease.value;
    },
  };
};
