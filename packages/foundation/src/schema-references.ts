import { ENGINE_ROOT_BASE } from './engine-root.ts';
import { dialectOfUri } from './untrusted-dialect.ts';
import type { SchemaDialect } from './untrusted-dialect.ts';

type Json = Record<string, unknown>;

type State = {
  readonly resources: Map<string, unknown>;
  readonly anchors: Map<string, Map<string, unknown>>;
  readonly nodeBase: Map<unknown, string>;
  rootBase: string;
};

const SINGLE_KEYWORDS = ['additionalProperties', 'contains', 'propertyNames', 'if', 'then', 'else', 'not', 'items', 'unevaluatedItems', 'unevaluatedProperties'] as const;
const MAP_KEYWORDS = ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas'] as const;
const LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;
const REFERENCE_KEYWORDS = ['$ref', '$dynamicRef'] as const;

const DRAFT_07_REF_SIBLINGS: ReadonlySet<string> = new Set(['$ref', '$defs', 'definitions', '$schema', '$comment', 'title', 'description', 'examples', 'default', 'readOnly', 'writeOnly']);
const DRAFT_07_MAP_SUBSCHEMAS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] as const;
const DRAFT_07_LIST_SUBSCHEMAS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;
const DRAFT_07_SINGLE_SUBSCHEMAS = ['items', 'contains', 'not', 'if', 'then', 'else', 'additionalProperties', 'propertyNames'] as const;
const PLAIN_NAME_ID = /^#[A-Za-z][A-Za-z0-9_.:-]*$/;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null;

const isRecord = (value: unknown): value is Json => isObject(value) && !Array.isArray(value);

const resolveUri = (base: string, reference: string): string => {
  try {
    return new URL(reference, base === '' ? ENGINE_ROOT_BASE : base).href;
  } catch {
    return reference;
  }
};

const splitFragment = (uri: string): [string, string] => {
  const hash = uri.indexOf('#');
  return hash < 0 ? [uri, ''] : [uri.slice(0, hash), decodeURIComponent(uri.slice(hash + 1))];
};

const normalizeDraft07 = (node: unknown): void => {
  if (!isObject(node)) return;
  const schema = node as Json;
  if (typeof schema['$ref'] === 'string') {
    for (const key of Object.keys(schema)) if (!DRAFT_07_REF_SIBLINGS.has(key)) delete schema[key];
  }
  const id = schema['$id'];
  if (typeof id === 'string' && PLAIN_NAME_ID.test(id)) {
    if (schema['$anchor'] === undefined) schema['$anchor'] = id.slice(1);
    delete schema['$id'];
  }
  if (schema['definitions'] && !schema['$defs']) {
    schema['$defs'] = schema['definitions'];
    delete schema['definitions'];
  }
  const dependencies = schema['dependencies'];
  if (dependencies && isRecord(dependencies)) {
    for (const [key, value] of Object.entries(dependencies)) {
      const target = Array.isArray(value) ? 'dependentRequired' : 'dependentSchemas';
      if (!schema[target]) schema[target] = {};
      Object.defineProperty(schema[target], key, { value, writable: true, enumerable: true, configurable: true });
    }
    delete schema['dependencies'];
  }
  if (Array.isArray(schema['items'])) {
    schema['prefixItems'] = schema['items'];
    if (schema['additionalItems'] !== undefined) {
      schema['items'] = schema['additionalItems'];
      delete schema['additionalItems'];
    } else {
      delete schema['items'];
    }
  }
  for (const keyword of DRAFT_07_MAP_SUBSCHEMAS) {
    const map = schema[keyword];
    if (isObject(map)) for (const key of Object.keys(map)) normalizeDraft07((map as Json)[key]);
  }
  for (const keyword of DRAFT_07_LIST_SUBSCHEMAS) {
    const list = schema[keyword];
    if (Array.isArray(list)) for (const entry of list) normalizeDraft07(entry);
  }
  for (const keyword of DRAFT_07_SINGLE_SUBSCHEMAS) normalizeDraft07(schema[keyword]);
};

const normalized = (document: unknown, draft07: boolean): unknown => {
  if (!draft07 || !isObject(document)) return document;
  const copy = structuredClone(document);
  normalizeDraft07(copy);
  return copy;
};

const anchorMapOf = (maps: Map<string, Map<string, unknown>>, base: string): Map<string, unknown> => {
  let map = maps.get(base);
  if (map === undefined) {
    map = new Map();
    maps.set(base, map);
  }
  return map;
};

const indexResource = (node: unknown, base: string, state: State): void => {
  if (!isObject(node)) return;
  if (!state.resources.has(base)) state.resources.set(base, node);
  walkSchema(node, base, state, true);
};

const walkSchema = (node: unknown, base: string, state: State, isResourceRoot: boolean): void => {
  if (!isObject(node)) return;
  const schema = node as Json;
  if (state.nodeBase.has(node)) return;
  state.nodeBase.set(node, base);
  if (!isResourceRoot && typeof schema['$id'] === 'string') {
    const embedded = splitFragment(resolveUri(base, schema['$id']))[0];
    state.nodeBase.delete(node);
    indexResource(node, embedded, state);
    return;
  }
  if (typeof schema['$anchor'] === 'string') anchorMapOf(state.anchors, base).set(schema['$anchor'], node);
  if (typeof schema['$dynamicAnchor'] === 'string') anchorMapOf(state.anchors, base).set(schema['$dynamicAnchor'], node);
  for (const keyword of SINGLE_KEYWORDS) if (schema[keyword] !== undefined) walkSchema(schema[keyword], base, state, false);
  for (const keyword of MAP_KEYWORDS) {
    const map = schema[keyword];
    if (isRecord(map)) for (const key of Object.keys(map)) walkSchema(map[key], base, state, false);
  }
  for (const keyword of LIST_KEYWORDS) {
    const list = schema[keyword];
    if (Array.isArray(list)) for (const entry of list) walkSchema(entry, base, state, false);
  }
  const dependencies = schema['propertyDependencies'];
  if (isRecord(dependencies)) {
    for (const choices of Object.values(dependencies)) {
      if (isRecord(choices)) for (const entry of Object.values(choices)) walkSchema(entry, base, state, false);
    }
  }
};

const indexSchemas = (root: unknown, documents: ReadonlyMap<string, unknown> | undefined): State => {
  const state: State = { resources: new Map(), anchors: new Map(), nodeBase: new Map(), rootBase: ENGINE_ROOT_BASE };
  const rootId = isObject(root) ? (root as Json)['$id'] : undefined;
  state.rootBase = typeof rootId === 'string' ? resolveUri(ENGINE_ROOT_BASE, splitFragment(rootId)[0]) : ENGINE_ROOT_BASE;
  indexResource(root, state.rootBase, state);
  if (documents !== undefined) {
    for (const [id, document] of documents) {
      const base = resolveUri(ENGINE_ROOT_BASE, splitFragment(id)[0]);
      if (!state.resources.has(base)) indexResource(document, base, state);
      if (!state.resources.has(id)) state.resources.set(id, document);
    }
  }
  return state;
};

const walkPointer = (root: unknown, pointer: string): unknown => {
  if (pointer === '' || pointer === '/') return root;
  let node: unknown = root;
  for (const raw of pointer.split('/').slice(1)) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(node)) return undefined;
    if (Array.isArray(node)) {
      node = node[Number(part)];
    } else if (part in node) {
      node = node[part];
    } else if (part === 'definitions' && node['$defs']) {
      node = node['$defs'];
    } else if (part === '$defs' && node['definitions']) {
      node = node['definitions'];
    } else if (part === 'items' && Array.isArray(node['prefixItems'])) {
      node = node['prefixItems'];
    } else {
      return undefined;
    }
  }
  return node;
};

export type EngineResolution = (absoluteReference: string) => boolean;

const resolves = (reference: string, fromBase: string, state: State, resolvesInEngine: EngineResolution): boolean => {
  const [uri, fragment] = splitFragment(resolveUri(fromBase, reference));
  let resource = state.resources.get(uri);
  let resourceBase = uri;
  if (resource === undefined && (uri === ENGINE_ROOT_BASE || uri === '')) {
    resource = state.resources.get(state.rootBase);
    resourceBase = state.rootBase;
  }
  if (resource === undefined) {
    const [rawUri, rawFragment] = splitFragment(reference);
    if (state.resources.has(rawUri)) {
      resource = state.resources.get(rawUri);
      resourceBase = rawUri;
      if (rawFragment === '') return resource !== undefined;
      if (rawFragment.startsWith('/')) return walkPointer(resource, rawFragment) !== undefined;
      return state.anchors.get(resourceBase)?.get(rawFragment) !== undefined;
    }
    return resolvesInEngine(resolveUri(fromBase, reference));
  }
  if (fragment === '') return true;
  if (fragment.startsWith('/')) return walkPointer(resource, fragment) !== undefined;
  return state.anchors.get(resourceBase)?.get(fragment) !== undefined;
};

export const unresolvableReference = (schema: Json, dialect: SchemaDialect, remotes: ReadonlyMap<string, unknown>, resolvesInEngine: EngineResolution): string | undefined => {
  const rootIsDraft07 = dialect === 'draft-07';
  const root = normalized(schema, rootIsDraft07);
  const documents = new Map<string, unknown>();
  for (const [key, document] of remotes) {
    if (!isObject(document)) continue;
    const declared = (document as Json)['$schema'];
    const draft07 = declared === undefined ? rootIsDraft07 : typeof declared === 'string' && dialectOfUri(declared) === 'draft-07';
    const entry = isRecord(document) && !('$id' in document) ? { ...document, $id: key } : document;
    const prepared = normalized(entry, draft07);
    documents.set(key, prepared);
    const id = isRecord(prepared) ? prepared['$id'] : undefined;
    const original = isRecord(entry) ? entry['$id'] : undefined;
    const declaredId = typeof id === 'string' && id !== '' ? id : typeof original === 'string' && original !== '' && original[0] !== '#' ? original : undefined;
    if (declaredId !== undefined && declaredId !== key) documents.set(declaredId, prepared);
  }
  const own = indexSchemas(root, undefined);
  const full = indexSchemas(root, documents);
  for (const [node, base] of own.nodeBase) {
    if (!isRecord(node)) continue;
    for (const keyword of REFERENCE_KEYWORDS) {
      const reference = node[keyword];
      if (typeof reference !== 'string') continue;
      try {
        if (!resolves(reference, base, full, resolvesInEngine)) return reference;
      } catch {
        return reference;
      }
    }
  }
  return undefined;
};
