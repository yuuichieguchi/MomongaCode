export type SchemaDialect = 'draft-07' | '2020-12';

type Resource = { readonly node: unknown; readonly anchors: Set<string> };
type Reference = { readonly ref: string; readonly base: string };

const SYNTHETIC_ROOT = 'http://momonga.invalid/root';

const SCHEMA_KEYWORDS = [
  'additionalProperties',
  'additionalItems',
  'items',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contentSchema',
] as const;
const SCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'] as const;
const SCHEMA_MAP_KEYWORDS = ['properties', 'patternProperties', 'dependentSchemas', 'dependencies', '$defs', 'definitions'] as const;

const BUILT_IN_METASCHEMAS: ReadonlySet<string> = new Set([
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/meta/core',
  'https://json-schema.org/draft/2020-12/meta/applicator',
  'https://json-schema.org/draft/2020-12/meta/validation',
  'https://json-schema.org/draft/2020-12/meta/meta-data',
  'https://json-schema.org/draft/2020-12/meta/format-annotation',
  'https://json-schema.org/draft/2020-12/meta/content',
  'https://json-schema.org/draft/2020-12/meta/unevaluated',
  'http://json-schema.org/draft-07/schema',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const resolveUri = (reference: string, base: string): string | undefined => {
  try {
    return new URL(reference, base).href;
  } catch {
    return undefined;
  }
};

const splitFragment = (uri: string): { document: string; fragment: string } => {
  const hash = uri.indexOf('#');
  return hash === -1 ? { document: uri, fragment: '' } : { document: uri.slice(0, hash), fragment: uri.slice(hash + 1) };
};

const pointerTarget = (root: unknown, pointer: string): { found: boolean } => {
  let node = root;
  for (const raw of pointer.split('/').slice(1)) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= node.length) return { found: false };
      node = node[Number(token)];
    } else if (isRecord(node)) {
      if (!Object.hasOwn(node, token)) return { found: false };
      node = node[token];
    } else {
      return { found: false };
    }
  }
  return { found: true };
};

const decodeFragment = (fragment: string): string | undefined => {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return undefined;
  }
};

type Collected = { readonly resources: Map<string, Resource>; readonly references: Reference[] };

const collect = (root: unknown, rootUri: string, dialect: SchemaDialect, into: Collected, recordReferences: boolean): void => {
  const visit = (node: unknown, base: string, resource: Resource): void => {
    if (!isRecord(node)) return;
    const ref = node['$ref'];
    const refSiblingsIgnored = dialect === 'draft-07' && typeof ref === 'string';
    let currentBase = base;
    let currentResource = resource;
    const id = refSiblingsIgnored ? undefined : node['$id'];
    if (typeof id === 'string') {
      if (dialect === 'draft-07' && id.startsWith('#')) {
        resource.anchors.add(id.slice(1));
      } else {
        const resolved = resolveUri(id, base);
        if (resolved !== undefined) {
          currentBase = splitFragment(resolved).document;
          currentResource = { node, anchors: new Set() };
          into.resources.set(currentBase, currentResource);
        }
      }
    }
    if (dialect === '2020-12') {
      for (const keyword of ['$anchor', '$dynamicAnchor'] as const) {
        const anchor = node[keyword];
        if (typeof anchor === 'string') currentResource.anchors.add(anchor);
      }
    }
    if (typeof ref === 'string' && recordReferences) into.references.push({ ref, base: currentBase });
    if (refSiblingsIgnored) return;
    for (const keyword of SCHEMA_KEYWORDS) visit(node[keyword], currentBase, currentResource);
    for (const keyword of SCHEMA_LIST_KEYWORDS) {
      const list = node[keyword];
      if (Array.isArray(list)) for (const entry of list) visit(entry, currentBase, currentResource);
    }
    for (const keyword of SCHEMA_MAP_KEYWORDS) {
      const map = node[keyword];
      if (isRecord(map)) for (const entry of Object.values(map)) visit(entry, currentBase, currentResource);
    }
  };
  const rootResource: Resource = { node: root, anchors: new Set() };
  into.resources.set(rootUri, rootResource);
  visit(root, rootUri, rootResource);
};

const firstUnresolvable = (collected: Collected): string | undefined => {
  for (const { ref, base } of collected.references) {
    const absolute = resolveUri(ref, base);
    if (absolute === undefined) return ref;
    const { document, fragment } = splitFragment(absolute);
    const resource = collected.resources.get(document);
    if (resource === undefined) {
      if (BUILT_IN_METASCHEMAS.has(document)) continue;
      return ref;
    }
    if (fragment === '') continue;
    const decoded = decodeFragment(fragment);
    if (decoded === undefined) return ref;
    if (decoded.startsWith('/')) {
      if (!pointerTarget(resource.node, decoded).found) return ref;
    } else if (!resource.anchors.has(decoded)) {
      return ref;
    }
  }
  return undefined;
};

export const unresolvableReference = (schema: Record<string, unknown>, dialect: SchemaDialect, remotes: ReadonlyMap<string, unknown>): string | undefined => {
  const collected: Collected = { resources: new Map(), references: [] };
  for (const [uri, document] of remotes) {
    const rootUri = splitFragment(uri).document;
    collect(document, rootUri, dialect, collected, false);
  }
  const declaredId = schema['$id'];
  const rootBase = typeof declaredId === 'string' ? (resolveUri(declaredId, SYNTHETIC_ROOT) ?? SYNTHETIC_ROOT) : SYNTHETIC_ROOT;
  collect(schema, splitFragment(rootBase).document, dialect, collected, true);
  return firstUnresolvable(collected);
};
