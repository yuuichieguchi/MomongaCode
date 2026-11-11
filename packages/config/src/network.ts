import { redactedUrl } from '@momonga/foundation';
import type { NetworkConfig, NetworkEnvName, SourcedValue } from '@momonga/foundation';
import type { NetworkSettings } from './settings.ts';

export type NetworkEnvironment = Readonly<Record<string, string | undefined>>;

const HTTPS_PROXY_NAMES = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'] as const satisfies readonly NetworkEnvName[];
const HTTP_PROXY_NAMES = ['http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'] as const satisfies readonly NetworkEnvName[];
const NO_PROXY_NAMES = ['no_proxy', 'NO_PROXY'] as const satisfies readonly NetworkEnvName[];

const firstSet = (env: NetworkEnvironment, names: readonly NetworkEnvName[]): SourcedValue | undefined => {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') return { value, source: name };
  }
  return undefined;
};

const firstOf = (...candidates: readonly (SourcedValue | undefined)[]): SourcedValue | undefined => candidates.find((candidate) => candidate !== undefined);

const fromSetting = (value: string | undefined, source: SourcedValue['source']): SourcedValue | undefined => (value === undefined ? undefined : { value, source });

export const resolveNetwork = (settings: NetworkSettings | undefined, env: NetworkEnvironment): NetworkConfig => {
  const ambient: NetworkEnvironment = settings?.environment === false ? {} : env;
  const httpSetting = fromSetting(settings?.httpProxy, 'network.httpProxy');
  const httpProxy = firstOf(httpSetting, firstSet(ambient, HTTP_PROXY_NAMES));
  const httpsProxy = firstOf(fromSetting(settings?.httpsProxy, 'network.httpsProxy'), httpSetting, firstSet(ambient, HTTPS_PROXY_NAMES));
  const noProxy = firstOf(fromSetting(settings?.noProxy, 'network.noProxy'), firstSet(ambient, NO_PROXY_NAMES));
  const caFile = firstSet(ambient, ['SSL_CERT_FILE']);
  const caFiles: SourcedValue[] = (settings?.extraCaFiles ?? []).map((value) => ({ value, source: 'network.extraCaFiles' }));
  if (caFile !== undefined) caFiles.push(caFile);
  return {
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(noProxy === undefined ? {} : { noProxy }),
    caFiles,
  };
};

export type ShownNetworkValue = SourcedValue | { readonly source: 'none' };

export type NetworkSources = {
  readonly httpProxy: ShownNetworkValue;
  readonly httpsProxy: ShownNetworkValue;
  readonly noProxy: ShownNetworkValue;
  readonly trust: readonly SourcedValue[];
};

const shownProxy = (resolved: SourcedValue | undefined): ShownNetworkValue => (resolved === undefined ? { source: 'none' } : { value: redactedUrl(resolved.value), source: resolved.source });

export const resolveNetworkSources = (settings: NetworkSettings | undefined, env: NetworkEnvironment): NetworkSources => {
  const { httpProxy, httpsProxy, noProxy, caFiles } = resolveNetwork(settings, env);
  return { httpProxy: shownProxy(httpProxy), httpsProxy: shownProxy(httpsProxy), noProxy: noProxy ?? { source: 'none' }, trust: caFiles };
};
