import { describeNetworkScope, enforcedNetworkScope } from '@momonga/foundation';
import { OPEN_NETWORK } from '@momonga/foundation';
import type { NetworkScope, SandboxNetworkSetting } from '@momonga/foundation';
import { SANDBOX_NETWORK_SCOPES } from '@momonga/sandbox';
import type { Sandbox } from '@momonga/sandbox';

export type UnkeptHosts = 'refuse' | SandboxNetworkSetting;

export type CallNetworkInput = { requested: NetworkScope; granted: NetworkScope; sandbox: Sandbox['kind']; unkeptHosts: UnkeptHosts };

export type AdmittedNetwork = { kind: 'admitted'; scope: NetworkScope; sandboxNetwork: 'deny' | 'allow'; unlimited?: true };

export type CallNetwork = { kind: 'refused'; reason: string } | AdmittedNetwork;

const formOf = (kind: NetworkScope['kind']): string => {
  switch (kind) {
    case 'none':
      return 'no network field';
    case 'hosts':
      return 'network {"hosts": [...]}';
    case 'open':
      return 'network "open"';
  }
};

export const acceptedNetworkForms = (sandbox: Sandbox['kind']): string[] => SANDBOX_NETWORK_SCOPES[sandbox].map(formOf);

const keepsTheHostOffTheNetwork = (sandbox: Sandbox['kind']): boolean => SANDBOX_NETWORK_SCOPES[sandbox].includes('none');

const unkeptReason = (requested: NetworkScope, sandbox: Sandbox['kind']): string =>
  `the command requests ${describeNetworkScope(requested)}, and the sandbox in use (${sandbox}) cannot hold a command to that; nothing wider is granted in its place. This sandbox accepts ${acceptedNetworkForms(sandbox).join(' or ')}`;

export const callNetworkOf = ({ requested, granted, sandbox, unkeptHosts }: CallNetworkInput): CallNetwork => {
  const accepted = SANDBOX_NETWORK_SCOPES[sandbox];
  if (requested.kind !== 'none' && !accepted.includes(requested.kind)) {
    if (requested.kind === 'hosts' && accepted.includes('open') && (unkeptHosts === 'ask' || unkeptHosts === 'allow')) return { kind: 'admitted', scope: OPEN_NETWORK, sandboxNetwork: 'allow', unlimited: true };
    const reason = unkeptReason(requested, sandbox);
    return { kind: 'refused', reason: unkeptHosts === 'deny' ? `${reason}, which the setting sandboxNetwork is deny refuses` : reason };
  }
  const scope = enforcedNetworkScope({ requested, granted, backend: accepted });
  return { kind: 'admitted', scope, sandboxNetwork: scope.kind === 'open' || !keepsTheHostOffTheNetwork(sandbox) ? 'allow' : 'deny' };
};
