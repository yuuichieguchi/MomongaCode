import type { Capabilities, ChainCapabilities, ChainMemberEntry, MomongaModelEntry, NotListedCapabilities, UnavailableCapabilities } from '@momonga/protocol';
import { isNotListedCapabilities } from '@momonga/protocol';
import { ClientDisconnectedError, GatewayError } from '../core/errors.ts';
import { UpstreamFailure, failureFrom, plainError } from '../core/retry.ts';
import { mergeCapabilities } from '../core/router.ts';
import type { Router, TargetRuntime } from '../core/router.ts';
import { isTargetProbing, probingOf } from '../probe/auto-probe.ts';

export type ListedCapabilities<C> = C | NotListedCapabilities;

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

const memberEntryOf = (target: TargetRuntime, capabilities: ListedCapabilities<Capabilities>): ChainMemberEntry => ({
  model: target.name,
  counter: target.counter,
  billing: target.billing,
  adapter: target.kind,
  answers: target.answers,
  upstream: target.model,
  ...(target.plan === undefined ? {} : { plan: target.plan }),
  ...(target.keyGroup === undefined ? {} : { key: { group: target.keyGroup } }),
  capabilities,
});

const chainCapabilitiesOf = async (router: Router, model: string, members: readonly TargetRuntime[], listed: readonly ListedCapabilities<Capabilities>[]): Promise<MomongaModelEntry['capabilities']> => {
  const [own] = listed;
  if (own === undefined) throw new Error(`model "${router.displayOf(model)}" has no models to try`);
  if (isNotListedCapabilities(own)) return own;
  const serving = members.filter((_member, index) => isListed(listed[index] as ListedCapabilities<Capabilities>));
  const refusal = await router.roomRefusalOf(model, serving);
  if (refusal !== undefined) return unavailableOf(refusal);
  return mergeCapabilities([own, ...listed.slice(1).filter(isListed)]);
};

export const listModel = async (router: Router, model: string, signal: AbortSignal): Promise<MomongaModelEntry> => {
  const members = router.chainOf(model);
  const [first] = members;
  if (first === undefined) throw new Error(`model "${router.displayOf(model)}" has no models to try`);
  const listed = await Promise.all(members.map((target) => listedOf(router, target, signal)));
  return {
    id: model,
    object: 'model',
    provider: first.provider,
    ownName: first.model,
    ...(first.defaultTag === undefined ? {} : { defaultTag: first.defaultTag }),
    billing: first.billing,
    capabilities: await chainCapabilitiesOf(router, model, members, listed),
    chain: members.map((target, index) => memberEntryOf(target, listed[index] as ListedCapabilities<Capabilities>)),
  };
};
