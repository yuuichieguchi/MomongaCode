import fs from 'node:fs';
import { loadUserSettings, resolveNetwork } from '@momonga/config';
import type { NetworkSettings } from '@momonga/config';
import { createOutboundDispatcher, installTrust, outboundFetch } from '@momonga/foundation';
import type { OutboundFetch, OutboundNetwork } from '@momonga/foundation';
import type { CliPorts } from './ports.ts';
import { escapedLines } from './terminal-writer.ts';

type NetworkPorts = Pick<CliPorts, 'home' | 'env' | 'stderr'>;

export const outboundNetworkOf = async (ports: NetworkPorts, settings: NetworkSettings | undefined): Promise<OutboundNetwork> => {
  const config = resolveNetwork(settings, ports.env);
  const trust = await installTrust(config, (file) => fs.promises.readFile(file, 'utf8'));
  for (const failure of trust.failures) ports.stderr.write(`${escapedLines([`momonga: the CA file ${failure.file} from ${failure.source} was not loaded: ${failure.reason}`])}\n`);
  return { config, trust };
};

export const withOutboundFetch = async <T>(ports: NetworkPorts, connectReplyTimeoutMs: number, use: (fetch: OutboundFetch) => Promise<T>): Promise<T> => {
  const { settings } = await loadUserSettings({ home: ports.home });
  const dispatcher = createOutboundDispatcher(await outboundNetworkOf(ports, settings.network), { connectReplyTimeoutMs });
  try {
    return await use(outboundFetch(dispatcher));
  } finally {
    await dispatcher.close();
  }
};
