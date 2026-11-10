import type { AliasCapabilities, Capabilities, NotListedCapabilities, UnavailableCapabilities } from '@momonga/protocol';
import { isNotListedCapabilities } from '@momonga/protocol';
import { ClientDisconnectedError, GatewayError } from '../core/errors.ts';
import { UpstreamFailure, failureFrom, plainError } from '../core/retry.ts';
import { mergeCapabilities } from '../core/router.ts';
import type { Router, TargetRuntime } from '../core/router.ts';
import { isTargetProbing, probingOf } from '../probe/auto-probe.ts';

export type ListedCapabilities<C> = C | NotListedCapabilities;

export type AliasListing = { capabilities: ListedCapabilities<AliasCapabilities>; targetCapabilities: Record<string, ListedCapabilities<Capabilities>> };

const unavailableOf = (error: GatewayError): UnavailableCapabilities => ({
  toolCalling: {
    state: 'unavailable',
    status: error.status,
    type: error.body.type,
    code: error.body.code ?? `http_${error.status}`,
    message: error.body.message,
    ...(error.body.param === null ? {} : { param: error.body.param }),
  },
  source: 'unprobed',
});

const listedOf = async (router: Router, target: TargetRuntime, signal: AbortSignal): Promise<ListedCapabilities<Capabilities>> => {
  try {
    return await router.capabilitiesOf(target);
  } catch (error) {
    if (isTargetProbing(error)) return { toolCalling: probingOf(error), source: 'unprobed' };
    if (error instanceof ClientDisconnectedError) throw error;
    const failure = failureFrom(target.adapter, error, signal);
    if (failure instanceof GatewayError) return unavailableOf(failure);
    if (failure instanceof UpstreamFailure) return unavailableOf(plainError(failure.classified));
    throw failure;
  }
};

const isListed = <C extends Capabilities>(entry: ListedCapabilities<C>): entry is C => !isNotListedCapabilities(entry);

export const listAlias = async (router: Router, alias: string, signal: AbortSignal): Promise<AliasListing> => {
  const listed = await Promise.all(router.targetsOf(alias).map(async (target) => [target.name, await listedOf(router, target, signal)] as const));
  const targetCapabilities = Object.fromEntries(listed);
  const entries = listed.map(([, entry]) => entry);
  const notListed = entries.find(isNotListedCapabilities);
  if (notListed !== undefined) return { capabilities: notListed, targetCapabilities };
  const [first, ...rest] = entries.filter(isListed);
  if (first === undefined) throw new Error(`model alias "${alias}" has no targets`);
  return { capabilities: mergeCapabilities([first, ...rest]), targetCapabilities };
};
