import { refTarget } from './references.ts';
import { IN_PLACE_KEYWORDS, childPointer, childrenOf, isRecord, resolvePointer, unevaluatedPropertiesActive } from './schema.ts';
import type { JsonObject } from './schema.ts';

type Entry = { readonly node: JsonObject; readonly location: string };
type ReferenceSite = { readonly target: string; readonly chain: readonly Entry[] };

const referenceSites = (document: unknown): ReferenceSite[] => {
  const sites: ReferenceSite[] = [];
  const visit = (node: unknown, location: string, above: readonly Entry[]): void => {
    if (!isRecord(node)) return;
    const chain = [{ node, location }, ...above];
    const ref = node['$ref'];
    if (typeof ref === 'string') {
      const target = refTarget(ref);
      if (target !== undefined) sites.push({ target, chain });
    }
    for (const child of childrenOf(node)) {
      visit(child.value, childPointer(location, child.keyword, child.key), IN_PLACE_KEYWORDS.has(child.keyword) ? chain : []);
    }
  };
  visit(document, '', []);
  return sites;
};

export type InPlaceScope = { readonly location: string; readonly inPlace: readonly string[]; readonly hasReferences: boolean };

export const unevaluatedFeeders = (document: unknown, scope: InPlaceScope): JsonObject[] => {
  const feeders = new Map<string, JsonObject>();
  const known = new Set([scope.location, ...scope.inPlace]);
  for (const location of scope.inPlace) {
    const node = resolvePointer(document, location);
    if (isRecord(node)) feeders.set(location, node);
  }
  if (scope.hasReferences) {
    const sites = referenceSites(document);
    let grew = true;
    while (grew) {
      grew = false;
      for (const site of sites) {
        if (!known.has(site.target)) continue;
        for (const entry of site.chain) {
          if (!feeders.has(entry.location)) feeders.set(entry.location, entry.node);
          if (!known.has(entry.location)) {
            known.add(entry.location);
            grew = true;
          }
        }
      }
    }
  }
  feeders.delete(scope.location);
  return [...feeders.values()];
};

export const feedsRestrictedProperties = (feeders: readonly JsonObject[]): boolean => feeders.some(unevaluatedPropertiesActive);
