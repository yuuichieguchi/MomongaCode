import { loadUserSettings, resolveNetwork } from '@momonga/config';
import { createOutboundDispatcher, installTrust, outboundFetch } from '@momonga/foundation';
import type { OutboundFetch, OutboundNetwork } from '@momonga/foundation';
import type { CliPorts } from './ports.ts';
import { escapedLines } from './terminal-writer.ts';

type NetworkPorts = Pick<CliPorts, 'home' | 'env' | 'stderr' | 'files'>;

let installed: Promise<OutboundNetwork> | undefined;

const resolveAndInstall = async (ports: NetworkPorts): Promise<OutboundNetwork> => {
  const { settings } = await loadUserSettings({ home: ports.home });
  const config = resolveNetwork(settings.network, ports.env);
  const trust = await installTrust(config, ports.files);
  for (const failure of trust.failures) ports.stderr.write(`${escapedLines([`momonga: the CA file ${failure.file} from ${failure.source} was not loaded: ${failure.reason}`])}\n`);
  return { config, trust };
};

export const processOutboundNetwork = (ports: NetworkPorts): Promise<OutboundNetwork> => {
  installed ??= resolveAndInstall(ports);
  return installed;
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
