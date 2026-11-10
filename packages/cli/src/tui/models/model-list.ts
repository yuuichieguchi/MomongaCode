import { displayMapOf } from '@momonga/protocol';
import type { GatewayHealth, MomongaModelEntry, MomongaModelList } from '@momonga/protocol';
import { SIGN_IN_REQUIRED_CODE } from '@momonga/protocol';
import { listingViewsOf } from '../../client/gateway-client.ts';
import { SEPARATOR } from '../../commands/models.ts';
import type { PickRow } from '../picker.tsx';
import type { FoundModel } from './add.ts';
import { SIGN_IN_REQUIRED_WORD } from './texts.ts';

export const CURRENT_MARK = 'current';
export const FOUND_SEPARATOR = 'Found on this computer';
export const CHAIN_ARROW = ' → ';

export type ModelListRow =
  | { readonly kind: 'configured'; readonly entry: MomongaModelEntry }
  | { readonly kind: 'separator' }
  | { readonly kind: 'found'; readonly found: FoundModel };

export type ModelListFacts = { readonly listing: Pick<MomongaModelList, 'data'>; readonly current: string | undefined; readonly health: Pick<GatewayHealth, 'models'>; readonly found: readonly FoundModel[] };

const stateWordOf = (entry: MomongaModelEntry, health: Pick<GatewayHealth, 'models'>): string | undefined => {
  const state = health.models[entry.chain[0]?.model ?? entry.id];
  if (state === undefined || state.ok) return undefined;
  return state.reason === SIGN_IN_REQUIRED_CODE ? SIGN_IN_REQUIRED_WORD : (state.reason ?? 'not ready');
};

export const configuredRowText = (entry: MomongaModelEntry, displays: ReadonlyMap<string, string>, current: string | undefined, health: Pick<GatewayHealth, 'models'>): string => {
  const names = entry.chain.map((member) => displays.get(member.model) ?? member.model);
  const [first, ...next] = names.length === 0 ? [displays.get(entry.id) ?? entry.id] : names;
  const state = stateWordOf(entry, health);
  return [`${first}${next.length === 0 ? '' : `${CHAIN_ARROW}${next.join(CHAIN_ARROW)}`}`, entry.billing, ...(state === undefined ? [] : [state]), ...(entry.id === current ? [CURRENT_MARK] : [])].join(SEPARATOR);
};

export const foundRowText = (found: FoundModel): string => [found.display, found.server.address].join(SEPARATOR);

export const modelListRows = ({ listing, current, health, found }: ModelListFacts): { rows: PickRow[]; listed: ModelListRow[] } => {
  const displays = displayMapOf(listingViewsOf(listing.data));
  const rows: PickRow[] = listing.data.map((entry) => ({ label: configuredRowText(entry, displays, current, health) }));
  const listed: ModelListRow[] = listing.data.map((entry) => ({ kind: 'configured', entry }));
  if (found.length === 0) return { rows, listed };
  return {
    rows: [...rows, { label: FOUND_SEPARATOR, separator: true }, ...found.map((entry) => ({ label: foundRowText(entry) }))],
    listed: [...listed, { kind: 'separator' }, ...found.map((entry): ModelListRow => ({ kind: 'found', found: entry }))],
  };
};
