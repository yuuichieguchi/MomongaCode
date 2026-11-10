import { createPinnedDerivation, createUserSettingsCache, derivedInputsOf, noKeptRecords, resolveNetwork } from '@momonga/config';
import type { PinnedDerivation, ResolvedSettings } from '@momonga/config';
import { HOST_READ_BOUND_MS, createOutboundDispatcher, systemTiming, installTrust, trustFailureText, outboundFetch } from '@momonga/foundation';
import type { OutboundFetch, OutboundNetwork } from '@momonga/foundation';
import type { CliPorts } from './ports.ts';
import { escapedLines } from './terminal-writer.ts';

type NetworkPorts = Pick<CliPorts, 'home' | 'env' | 'stderr' | 'files'>;

const warn = (ports: NetworkPorts, message: string): void => {
  ports.stderr.write(`${escapedLines([`momonga: ${message}`])}\n`);
};

const resolveAndInstall = async (ports: NetworkPorts, settings: ResolvedSettings, signal: AbortSignal): Promise<OutboundNetwork> => {
  const config = resolveNetwork(settings.network, ports.env);
  const bound = new AbortController();
  const timer = systemTiming.setTimeout(() => bound.abort(new Error(`the read took longer than ${HOST_READ_BOUND_MS} ms`)), HOST_READ_BOUND_MS);
  const trust = await installTrust(config, ports.files, { signal: AbortSignal.any([signal, bound.signal]) }).finally(() => systemTiming.clearTimeout(timer));
  for (const failure of trust.failures) warn(ports, trustFailureText(failure));
  return { config, trust };
};

const networksByHome = new Map<string, PinnedDerivation<OutboundNetwork>>();

const processLifetime = new AbortController();

const networksOf = (ports: NetworkPorts): PinnedDerivation<OutboundNetwork> => {
  const known = networksByHome.get(ports.home);
  if (known !== undefined) return known;
  const created = createPinnedDerivation<OutboundNetwork>({
    cache: createUserSettingsCache({ home: ports.home, onWarning: (message) => warn(ports, message), keptRecords: noKeptRecords }),
    signal: processLifetime.signal,
    inputsOf: derivedInputsOf('D4'),
    derive: (settings, _previous, signal) => resolveAndInstall(ports, settings, signal),
    retire: () => undefined,
    onWarning: (message) => warn(ports, message),
  });
  networksByHome.set(ports.home, created);
  return created;
};

export const withOutboundNetwork = async <T>(ports: NetworkPorts, signal: AbortSignal, use: (network: OutboundNetwork) => Promise<T>): Promise<T> => {
  const lease = await networksOf(ports).admit(signal);
  try {
    return await use(lease.value);
  } finally {
    lease.release();
  }
};

export const withIdentityReadFetch = async <T>(ports: NetworkPorts, signal: AbortSignal, use: (fetch: OutboundFetch) => Promise<T>): Promise<T> => {
  const { IDENTITY_READ_TIMEOUT_MS } = await import('@momonga/gateway');
  return withOutboundNetwork(ports, signal, async (network) => {
    const dispatcher = createOutboundDispatcher(network, {
      connectReplyTimeoutMs: IDENTITY_READ_TIMEOUT_MS,
      headersTimeout: IDENTITY_READ_TIMEOUT_MS,
      bodyTimeout: IDENTITY_READ_TIMEOUT_MS,
    });
    try {
      return await use(outboundFetch(dispatcher));
    } finally {
      await dispatcher.close();
    }
  });
};
