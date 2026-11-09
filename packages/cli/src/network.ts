import { createPinnedDerivation, createUserSettingsCache, derivedInputsOf, noKeptRecords, resolveNetwork } from '@momonga/config';
import type { PinnedDerivation, ResolvedSettings } from '@momonga/config';
import { createOutboundDispatcher, installTrust, outboundFetch } from '@momonga/foundation';
import type { OutboundFetch, OutboundNetwork } from '@momonga/foundation';
import type { CliPorts } from './ports.ts';
import { escapedLines } from './terminal-writer.ts';

type NetworkPorts = Pick<CliPorts, 'home' | 'env' | 'stderr' | 'files'>;

const warn = (ports: NetworkPorts, message: string): void => {
  ports.stderr.write(`${escapedLines([`momonga: ${message}`])}\n`);
};

const resolveAndInstall = async (ports: NetworkPorts, settings: ResolvedSettings): Promise<OutboundNetwork> => {
  const config = resolveNetwork(settings.network, ports.env);
  const trust = await installTrust(config, ports.files);
  for (const failure of trust.failures) warn(ports, `the CA file ${failure.file} from ${failure.source} was not loaded: ${failure.reason}`);
  return { config, trust };
};

const networksByHome = new Map<string, PinnedDerivation<OutboundNetwork>>();

const networksOf = (ports: NetworkPorts): PinnedDerivation<OutboundNetwork> => {
  const known = networksByHome.get(ports.home);
  if (known !== undefined) return known;
  const created = createPinnedDerivation<OutboundNetwork>({
    cache: createUserSettingsCache({ home: ports.home, onWarning: (message) => warn(ports, message), keptRecords: noKeptRecords }),
    inputsOf: derivedInputsOf('D4'),
    derive: (settings) => resolveAndInstall(ports, settings),
    retire: () => undefined,
    onWarning: (message) => warn(ports, message),
  });
  networksByHome.set(ports.home, created);
  return created;
};

export const processOutboundNetwork = async (ports: NetworkPorts): Promise<OutboundNetwork> => {
  const lease = await networksOf(ports).admit(new AbortController().signal);
  lease.release();
  return lease.value;
};

export const withIdentityReadFetch = async <T>(ports: NetworkPorts, use: (fetch: OutboundFetch) => Promise<T>): Promise<T> => {
  const { IDENTITY_READ_TIMEOUT_MS } = await import('@momonga/gateway');
  const dispatcher = createOutboundDispatcher(await processOutboundNetwork(ports), {
    connectReplyTimeoutMs: IDENTITY_READ_TIMEOUT_MS,
    headersTimeout: IDENTITY_READ_TIMEOUT_MS,
    bodyTimeout: IDENTITY_READ_TIMEOUT_MS,
  });
  try {
    return await use(outboundFetch(dispatcher));
  } finally {
    await dispatcher.close();
  }
};
