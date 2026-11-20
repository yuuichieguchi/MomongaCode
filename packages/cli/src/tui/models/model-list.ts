import { displayMapOf } from '@momonga/protocol';
import type { GatewayHealth, MomongaModelEntry, MomongaModelList, TargetBilling } from '@momonga/protocol';
import { SIGN_IN_REQUIRED_CODE } from '@momonga/protocol';
import { listingViewsOf } from '../../client/gateway-client.ts';
import { NO_VALUE_CELL, foundBillingOf } from '../../commands/models.ts';
import { alignedRows } from '../../aligned-columns.ts';
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

export type PlanListRow = { readonly kind: 'model'; readonly slug: string; readonly billing: TargetBilling; readonly reason?: string; readonly searchTexts: readonly string[] } | { readonly kind: 'note'; readonly label: string };

export type ModelListFacts = { readonly listing: Pick<MomongaModelList, 'data'>; readonly current: string | undefined; readonly health: Pick<GatewayHealth, 'models'>; readonly found: readonly FoundModel[]; readonly plan: readonly PlanListRow[] };

type ModelCells = { readonly name: string; readonly billing: TargetBilling; readonly state?: string; readonly disabled?: true; readonly searchTexts?: readonly string[] };

type ListItem = { readonly cells: ModelCells } | { readonly row: PickRow };

const stateWordOf = (entry: MomongaModelEntry, health: Pick<GatewayHealth, 'models'>): string | undefined => {
  const state = health.models[entry.chain[0]?.model ?? entry.id];
  if (state === undefined || state.ok) return undefined;
  return state.reason === SIGN_IN_REQUIRED_CODE ? SIGN_IN_REQUIRED_WORD : (state.reason ?? 'not ready');
};

const configuredCellsOf = (entry: MomongaModelEntry, displays: ReadonlyMap<string, string>, current: string | undefined, health: Pick<GatewayHealth, 'models'>): ModelCells => {
  const names = entry.chain.map((member) => displays.get(member.model) ?? member.model);
  const [first, ...next] = names.length === 0 ? [displays.get(entry.id) ?? entry.id] : names;
  const state = stateWordOf(entry, health);
  const name = `${first}${next.length === 0 ? '' : `${CHAIN_ARROW}${next.join(CHAIN_ARROW)}`}${entry.id === current ? ` (${CURRENT_MARK})` : ''}`;
  return { name, billing: entry.billing, ...(state === undefined ? {} : { state }) };
};

const planItemOf = (row: PlanListRow): ListItem =>
  row.kind === 'note' ? { row: { label: row.label, disabled: true } } : { cells: { name: row.slug, billing: row.billing, searchTexts: row.searchTexts, ...(row.reason === undefined ? {} : { state: row.reason, disabled: true }) } };

const pickRowsOf = (items: readonly ListItem[]): PickRow[] => {
  const cells = items.flatMap((item) => ('cells' in item ? [item.cells] : []));
  const stated = cells.some((cell) => cell.state !== undefined);
  const labels = alignedRows(cells.map((cell) => (stated ? [cell.name, cell.billing, cell.state ?? NO_VALUE_CELL] : [cell.name, cell.billing])));
  let next = 0;
  return items.map((item) => {
    if (!('cells' in item)) return item.row;
    const label = labels[next] as string;
    next += 1;
    return { label, ...(item.cells.disabled === undefined ? {} : { disabled: true }), ...(item.cells.searchTexts === undefined ? {} : { searchTexts: item.cells.searchTexts }) };
  });
};

export const modelListRows = ({ listing, current, health, found, plan }: ModelListFacts): { rows: PickRow[]; listed: ModelListRow[] } => {
  const displays = displayMapOf(listingViewsOf(listing.data));
  const configured: ListItem[] = listing.data.map((entry) => ({ cells: configuredCellsOf(entry, displays, current, health) }));
  const foundItems: ListItem[] = found.length === 0 ? [] : [{ row: { label: FOUND_SEPARATOR, separator: true } }, ...found.map((entry): ListItem => ({ cells: { name: entry.display, billing: foundBillingOf(entry.server) } }))];
  const listed: ModelListRow[] = [...listing.data.map((entry): ModelListRow => ({ kind: 'configured', entry })), ...(found.length === 0 ? [] : [{ kind: 'separator' } as const, ...found.map((entry): ModelListRow => ({ kind: 'found', found: entry }))])];
  return { rows: pickRowsOf([...configured, ...foundItems, ...plan.map(planItemOf)]), listed };
};
