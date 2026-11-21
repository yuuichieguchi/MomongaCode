import { resolveNetwork } from '@momonga/config';
import type { NetworkEnvironment, NetworkSettings } from '@momonga/config';
import { redactedUrl, trustFailureText } from '@momonga/foundation';
import type { NetworkConfig, Route, SourcedValue, TrustReport } from '@momonga/foundation';
import type { SlashCommand } from '../slash.ts';

export type NetworkView = { settings: NetworkSettings | undefined; env: NetworkEnvironment; trust: TrustReport };

export type NetworkCheckResult = { kind: 'answered'; status: number } | { kind: 'failed'; hop: 'proxy' | 'origin'; text: string };

export type NetworkCheck = { route: Route; result: NetworkCheckResult };

type ProxyKey = 'httpProxy' | 'httpsProxy' | 'noProxy';

const SHOWN: readonly { key: ProxyKey; label: string; url: boolean }[] = [
  { key: 'httpsProxy', label: 'HTTPS proxy', url: true },
  { key: 'httpProxy', label: 'HTTP proxy', url: true },
  { key: 'noProxy', label: 'No proxy for', url: false },
];

const fromSetting = (value: SourcedValue): boolean => value.source.startsWith('network.');

type Shown = { value: string; source: string; overrides: string[] } | { source: 'none' };

const shownOf = (config: NetworkConfig, ambient: NetworkConfig, key: ProxyKey, url: boolean): Shown => {
  const chosen = config[key];
  if (chosen === undefined) return { source: 'none' };
  const lost = ambient[key];
  return { value: url ? redactedUrl(chosen.value) : chosen.value, source: chosen.source, overrides: fromSetting(chosen) && lost !== undefined ? [lost.source] : [] };
};

const resolvedOf = (view: NetworkView): { config: NetworkConfig; ambient: NetworkConfig } => ({ config: resolveNetwork(view.settings, view.env), ambient: resolveNetwork(undefined, view.env) });

const trustSourceText = (source: TrustReport['sources'][number]): string => ('file' in source ? `${source.file} ${source.certificates} (${source.source})` : `${source.source} ${source.certificates}`);

export const networkLines = (view: NetworkView): string[] => {
  const { config, ambient } = resolvedOf(view);
  return [
    ...SHOWN.map(({ key, label, url }) => {
      const shown = shownOf(config, ambient, key, url);
      if (!('value' in shown)) return `${label}: none`;
      return `${label}: ${shown.value}  from ${shown.source}${shown.overrides.length === 0 ? '' : ` (overrides ${shown.overrides.join(', ')})`}`;
    }),
    ...(view.settings?.environment === false ? ['The proxy variables of the environment are not read: network.environment is false'] : []),
    `Trusted certificates: ${view.trust.sources.map(trustSourceText).join(', ')}`,
    ...view.trust.failures.map((failure) => `Not loaded: ${trustFailureText(failure)}`),
  ];
};

export const networkJson = (view: NetworkView): Readonly<Record<string, unknown>> => {
  const { config, ambient } = resolvedOf(view);
  return { ...Object.fromEntries(SHOWN.map(({ key, url }) => [key, shownOf(config, ambient, key, url)])), environment: view.settings?.environment !== false, trust: view.trust };
};

const routeText = (route: Route): string => {
  switch (route.kind) {
    case 'direct':
      return 'direct';
    case 'bypass':
      return `direct, ${route.source} names the host`;
    case 'proxy':
      return `through the proxy ${route.display} from ${route.source}`;
    case 'unsupported':
      return route.message;
  }
};

export const networkCheckLines = (target: string, check: NetworkCheck): string[] => [
  `${target}: ${routeText(check.route)}`,
  check.result.kind === 'answered' ? `answered ${check.result.status}` : `failed at the ${check.result.hop}: ${check.result.text}`,
];

export const NETWORK_USAGE = 'usage: /network [--json] | /network check <url>';

const urlOf = (text: string): URL | undefined => (URL.canParse(text) ? new URL(text) : undefined);

export const networkCommand: SlashCommand = {
  name: 'network',
  needsSession: false,
  usage: '[--json] | check <url>',
  description: 'show the proxy and the trusted certificates in force with the setting or variable each comes from, or check the route to an address',
  subcommands: [{ name: 'check', usage: '<url>', description: 'check the route to an address' }],
  run: async (args, context) => {
    const [first, second, ...rest] = args.split(/\s+/).filter((word) => word !== '');
    if (first === 'check') {
      const target = second === undefined || rest.length > 0 ? undefined : urlOf(second);
      if (target === undefined) {
        context.info(NETWORK_USAGE);
        return;
      }
      const check = await context.background('/network check', (signal) => context.backend.checkNetwork(target, signal));
      context.info(networkCheckLines(target.href, check).join('\n'));
      return;
    }
    if ((first !== undefined && first !== '--json') || second !== undefined) {
      context.info(NETWORK_USAGE);
      return;
    }
    const view = await context.background('/network', (signal) => context.backend.network(signal));
    context.info(first === '--json' ? JSON.stringify(networkJson(view)) : networkLines(view).join('\n'));
  },
};
