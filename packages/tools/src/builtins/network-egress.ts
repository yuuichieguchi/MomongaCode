import { systemRandom } from '@momonga/foundation';
import { describeEgressRefusal, startEgressProxy } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { withNetwork } from '../read-only-call.ts';
import type { ToolContext } from '../types.ts';

export type GrantedNetwork = {
  sandboxPolicy: SandboxPolicy;
  env: Readonly<Record<string, string>>;
  proxy?: string;
  settle(): Promise<string[]>;
};

const PROXY_VARIABLES: readonly string[] = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const NO_PROXY_VARIABLES: readonly string[] = ['NO_PROXY', 'no_proxy'];

const proxyEnvironment = (url: string): Record<string, string> => ({
  ...Object.fromEntries(PROXY_VARIABLES.map((name) => [name, url])),
  ...Object.fromEntries(NO_PROXY_VARIABLES.map((name) => [name, ''])),
});

export const openGrantedNetwork = async (ctx: Pick<ToolContext, 'network' | 'outboundNetwork' | 'sandboxPolicy' | 'env'>): Promise<GrantedNetwork> => {
  if (ctx.network?.kind !== 'hosts') return { sandboxPolicy: ctx.sandboxPolicy, env: ctx.env, settle: async () => [] };
  const proxy = await startEgressProxy({ hosts: ctx.network.hosts, network: ctx.outboundNetwork, random: systemRandom });
  return {
    sandboxPolicy: withNetwork(ctx.sandboxPolicy, { loopbackPort: proxy.port }),
    env: { ...ctx.env, ...proxyEnvironment(proxy.url) },
    proxy: proxy.url,
    settle: async () => {
      await proxy.close();
      return [...new Set(proxy.refusals().map((refusal) => `[network] ${describeEgressRefusal(refusal, proxy.hosts)}`))];
    },
  };
};
