import { ENGINE_ROOT_BASE } from './engine-root.ts';
import { pointerTrail, resolveReference, resolveUri, splitFragment } from './schema-references.ts';
import { dialectOfUri } from './untrusted-dialect.ts';
import type { SchemaDialect } from './untrusted-dialect.ts';

type Json = Record<string, unknown>;

type Edge = { readonly target: Json; readonly pointer: string };

type Location = {
  readonly node: Json;
  readonly base: string;
  readonly pointer: string;
  readonly document: string;
  readonly draft07: boolean;
  readonly inPlace: { readonly child: Json; readonly pointer: string }[];
};

type Pending = { readonly node: unknown; readonly base: string; readonly pointer: string; readonly document: string; readonly draft07: boolean; readonly resourceRoot: boolean };

type Index = {
  readonly locations: Map<Json, Location>;
  readonly resources: Map<string, Json>;
  readonly anchors: Map<string, Map<string, Json>>;
  readonly dynamicAnchors: Map<string, Json[]>;
  readonly documents: Map<Json, Document>;
  readonly pendingRemotes: Set<Json>;
  readonly owners: Map<Json, Json>;
  readonly rootBase: string;
};

type Document = { readonly document: string; readonly draft07: boolean; readonly prefix: string };

const IN_PLACE_SINGLE = ['not', 'if', 'then', 'else'] as const;
const IN_PLACE_LIST = ['allOf', 'anyOf', 'oneOf'] as const;
const CHILD_SINGLE = ['additionalProperties', 'additionalItems', 'contains', 'propertyNames', 'items', 'unevaluatedItems', 'unevaluatedProperties', 'contentSchema'] as const;
const CHILD_MAP = ['properties', 'patternProperties'] as const;
const CHILD_LIST = ['prefixItems', 'items'] as const;
const PLAIN_NAME_ID = /^#[A-Za-z][A-Za-z0-9_.:-]*$/;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const FRAGMENT_SAFE = /^[A-Za-z0-9\-._~!$&'()*+,;=:@?]$/;

const percentEncode = (text: string): string => [...text].map((char) => (FRAGMENT_SAFE.test(char) ? char : encodeURIComponent(char))).join('');

const escapePointer = (segment: string): string => percentEncode(segment.replace(/~/g, '~0').replace(/\//g, '~1'));

const encodedPointer = (pointer: string): string => pointer.split('/').map(percentEncode).join('/');

const listOf = <K, V>(map: Map<K, V[]>, key: K): V[] => {
  let list = map.get(key);
  if (list === undefined) {
    list = [];
    map.set(key, list);
  }
  return list;
};

const anchorsOf = (anchors: Map<string, Map<string, Json>>, base: string): Map<string, Json> => {
  let map = anchors.get(base);
  if (map === undefined) {
    map = new Map();
    anchors.set(base, map);
  }
  return map;
};

const indexLocations = (root: Pending, index: Index, scanOnly: boolean): void => {
  const queue: Pending[] = [root];
  const seen = new Set<Json>();
  for (let position = 0; position < queue.length; position += 1) {
    const item = queue[position]!;
    if (!isRecord(item.node) || seen.has(item.node) || index.locations.has(item.node)) continue;
    const node = item.node;
    seen.add(node);
    let base = item.base;
    let document = item.document;
    let pointer = item.pointer;
    const id = node['$id'];
    const register = (resourceBase: string): void => {
      if (index.resources.has(resourceBase)) return;
      index.resources.set(resourceBase, node);
      index.owners.set(node, root.node as Json);
    };
    if (item.resourceRoot) {
      register(base);
    } else if (typeof id === 'string') {
      if (item.draft07 && PLAIN_NAME_ID.test(id)) {
        anchorsOf(index.anchors, base).set(id.slice(1), node);
      } else {
        base = splitFragment(resolveUri(base, id))[0];
        register(base);
        if (document !== '') {
          document = base;
          pointer = '';
          index.documents.set(node, { document, draft07: item.draft07, prefix: '' });
        } else {
          index.documents.set(node, { document, draft07: item.draft07, prefix: pointer });
        }
      }
    }
    for (const keyword of ['$anchor', '$dynamicAnchor'] as const) {
      const name = node[keyword];
      if (typeof name === 'string') anchorsOf(index.anchors, base).set(name, node);
    }
    const dynamicName = node['$dynamicAnchor'];
    if (!scanOnly && typeof dynamicName === 'string') listOf(index.dynamicAnchors, dynamicName).push(node);
    const location: Location = { node, base, pointer, document, draft07: item.draft07, inPlace: [] };
    if (!scanOnly) index.locations.set(node, location);
    const visit = (child: unknown, segments: readonly string[], inPlace: boolean): void => {
      if (!isRecord(child)) return;
      const childPointer = `${pointer}${segments.map((segment) => `/${escapePointer(segment)}`).join('')}`;
      if (inPlace) location.inPlace.push({ child, pointer: childPointer });
      queue.push({ node: child, base, pointer: childPointer, document, draft07: item.draft07, resourceRoot: false });
    };
    const visitMap = (keyword: string, inPlace: boolean): void => {
      const map = node[keyword];
      if (isRecord(map)) for (const key of Object.keys(map)) visit(map[key], [keyword, key], inPlace);
    };
    const visitList = (keyword: string, inPlace: boolean): void => {
      const list = node[keyword];
      if (Array.isArray(list)) list.forEach((entry, at) => visit(entry, [keyword, String(at)], inPlace));
    };
    visitMap('$defs', false);
    visitMap('definitions', false);
    if (item.draft07 && typeof node['$ref'] === 'string') continue;
    for (const keyword of IN_PLACE_SINGLE) visit(node[keyword], [keyword], true);
    for (const keyword of IN_PLACE_LIST) visitList(keyword, true);
    visitMap('dependentSchemas', true);
    if (item.draft07) visitMap('dependencies', true);
    for (const keyword of CHILD_SINGLE) visit(node[keyword], [keyword], false);
    for (const keyword of CHILD_MAP) visitMap(keyword, false);
    for (const keyword of CHILD_LIST) visitList(keyword, false);
    const propertyDependencies = node['propertyDependencies'];
    if (isRecord(propertyDependencies)) {
      for (const [property, choices] of Object.entries(propertyDependencies)) {
        if (isRecord(choices)) for (const value of Object.keys(choices)) visit(choices[value], ['propertyDependencies', property, value], false);
      }
    }
  }
};

const enterRemote = (uri: string, index: Index): void => {
  const resource = index.resources.get(uri);
  if (resource === undefined) return;
  const owner = index.owners.get(resource) ?? resource;
  if (!index.pendingRemotes.delete(owner)) return;
  const entry = index.documents.get(owner);
  if (entry === undefined) throw new Error(`SCHEMA_REFERENCE_UNLOCATED: remote document "${uri}" is not registered`);
  indexLocations({ node: owner, base: resolveUri(ENGINE_ROOT_BASE, splitFragment(entry.document)[0]), pointer: '', document: entry.document, draft07: entry.draft07, resourceRoot: true }, index, false);
};

const baseAlong = (trail: readonly unknown[], start: string, draft07: boolean): string => {
  let base = start;
  for (const step of trail.slice(1, -1)) {
    const id = isRecord(step) ? step['$id'] : undefined;
    if (typeof id === 'string' && !(draft07 && PLAIN_NAME_ID.test(id))) base = splitFragment(resolveUri(base, id))[0];
  }
  return base;
};

const lookup = (reference: string, from: Location, index: Index): Json | undefined => {
  enterRemote(splitFragment(resolveUri(from.base, reference))[0], index);
  enterRemote(splitFragment(reference)[0], index);
  const resolved = resolveReference(reference, from.base, index);
  if (resolved.kind === 'engine') return undefined;
  if (resolved.target === undefined) throw new Error(`SCHEMA_REFERENCE_UNLOCATED: reference "${reference}" resolves for the engine but its target cannot be located`);
  if (!isRecord(resolved.target)) return undefined;
  const target = resolved.target;
  if (index.locations.has(target)) return target;
  const entry = isRecord(resolved.resource) ? index.documents.get(resolved.resource) : undefined;
  const document = entry?.document ?? from.document;
  const draft07 = entry?.draft07 ?? from.draft07;
  const trail = resolved.fragment.startsWith('/') ? pointerTrail(resolved.resource, resolved.fragment) : [resolved.resource];
  const base = trail === undefined ? resolved.resourceBase : baseAlong(trail, resolved.resourceBase, draft07);
  indexLocations({ node: target, base, pointer: resolved.fragment.startsWith('/') ? `${entry?.prefix ?? ''}${encodedPointer(resolved.fragment)}` : entry?.prefix ?? '', document, draft07, resourceRoot: false }, index, false);
  return target;
};

const edgesOf = (location: Location, index: Index): Edge[] => {
  const edges: Edge[] = location.inPlace.map(({ child, pointer }) => ({ target: child, pointer }));
  const reference = location.node['$ref'];
  if (typeof reference === 'string') {
    const target = lookup(reference, location, index);
    if (target !== undefined) edges.push({ target, pointer: `${location.pointer}/$ref` });
  }
  const dynamic = location.draft07 ? undefined : location.node['$dynamicRef'];
  if (typeof dynamic === 'string') {
    const pointer = `${location.pointer}/$dynamicRef`;
    const target = lookup(dynamic, location, index);
    if (target !== undefined) edges.push({ target, pointer });
    const fragment = splitFragment(resolveUri(location.base, dynamic))[1];
    for (const candidate of index.dynamicAnchors.get(fragment) ?? []) edges.push({ target: candidate, pointer });
  }
  return edges;
};

const labelOf = (location: Location, pointer: string): string => (location.document === '' ? `#${pointer}` : `${location.document}#${pointer}`);

export const inPlaceReferenceCycle = (schema: Json, dialect: SchemaDialect, remotes: ReadonlyMap<string, unknown>): string | undefined => {
  const rootIsDraft07 = dialect === 'draft-07';
  const rootId = schema['$id'];
  const index: Index = {
    locations: new Map(),
    resources: new Map(),
    anchors: new Map(),
    dynamicAnchors: new Map(),
    documents: new Map(),
    pendingRemotes: new Set(),
    owners: new Map(),
    rootBase: typeof rootId === 'string' ? resolveUri(ENGINE_ROOT_BASE, splitFragment(rootId)[0]) : ENGINE_ROOT_BASE,
  };
  index.documents.set(schema, { document: '', draft07: rootIsDraft07, prefix: '' });
  indexLocations({ node: schema, base: index.rootBase, pointer: '', document: '', draft07: rootIsDraft07, resourceRoot: true }, index, false);
  const starts = [...index.locations.values()];
  for (const [key, document] of remotes) {
    if (!isRecord(document)) continue;
    const declared = document['$schema'];
    const draft07 = declared === undefined ? rootIsDraft07 : typeof declared === 'string' && dialectOfUri(declared) === 'draft-07';
    const prepared = '$id' in document ? document : { ...document, $id: key };
    index.documents.set(prepared, { document: key, draft07, prefix: '' });
    index.pendingRemotes.add(prepared);
    indexLocations({ node: prepared, base: resolveUri(ENGINE_ROOT_BASE, splitFragment(key)[0]), pointer: '', document: key, draft07, resourceRoot: true }, index, true);
    if (!index.resources.has(key)) index.resources.set(key, prepared);
    const declaredId = prepared['$id'];
    if (typeof declaredId === 'string' && declaredId !== '' && declaredId[0] !== '#' && !index.resources.has(declaredId)) index.resources.set(declaredId, prepared);
  }
  const finished = new Set<Json>();
  const onPath = new Set<Json>();
  for (const start of starts) {
    if (finished.has(start.node)) continue;
    const path: { readonly location: Location; readonly edges: Edge[]; position: number }[] = [{ location: start, edges: edgesOf(start, index), position: 0 }];
    onPath.add(start.node);
    while (path.length > 0) {
      const frame = path[path.length - 1]!;
      const edge = frame.edges[frame.position];
      if (edge === undefined) {
        path.pop();
        onPath.delete(frame.location.node);
        finished.add(frame.location.node);
        continue;
      }
      frame.position += 1;
      if (onPath.has(edge.target)) return labelOf(frame.location, edge.pointer);
      const next = index.locations.get(edge.target);
      if (next === undefined || finished.has(edge.target)) continue;
      onPath.add(edge.target);
      path.push({ location: next, edges: edgesOf(next, index), position: 0 });
    }
  }
  return undefined;
};
