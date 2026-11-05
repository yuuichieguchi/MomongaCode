type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const STRICT_CLOSED_REFUSED_KEYWORDS = [
  '$ref',
  '$defs',
  'definitions',
  'allOf',
  'oneOf',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
  'unevaluatedProperties',
  'propertyNames',
  'contains',
  'prefixItems',
  'not',
  'if',
  'then',
  'else',
] as const;

const INLINED_SUBSET_REFUSED_KEYWORDS = ['$ref', '$defs', 'definitions', '$schema'] as const;

const childSchemas = (node: Json, path: string): [string, unknown][] => {
  const children: [string, unknown][] = [];
  if (isRecord(node['properties'])) {
    for (const [name, child] of Object.entries(node['properties'])) children.push([`${path}/properties/${name}`, child]);
  }
  if ('items' in node) children.push([`${path}/items`, node['items']]);
  if (Array.isArray(node['anyOf'])) node['anyOf'].forEach((branch, index) => children.push([`${path}/anyOf/${index}`, branch]));
  return children;
};

const refusedKeyword = (node: Json, keywords: readonly string[], path: string): string | undefined => {
  const keyword = keywords.find((candidate) => candidate in node);
  return keyword === undefined ? undefined : `${keyword} is not supported (at ${path === '' ? '/' : path})`;
};

const undeclaredRequired = (node: Json, path: string): string | undefined => {
  const properties = isRecord(node['properties']) ? node['properties'] : {};
  const required = Array.isArray(node['required']) ? node['required'] : [];
  const unknown = required.find((name) => typeof name === 'string' && !(name in properties));
  return unknown === undefined ? undefined : `required names ${String(unknown)}, which is not a declared property (at ${path === '' ? '/' : path})`;
};

const walk = (node: unknown, path: string, check: (node: Json, path: string) => string | undefined): string[] => {
  if (!isRecord(node)) return [];
  const refusal = check(node, path);
  return [...(refusal === undefined ? [] : [refusal]), ...childSchemas(node, path).flatMap(([childPath, child]) => walk(child, childPath, check))];
};

const verdictOf = (refusals: string[]): string | undefined => (refusals.length === 0 ? undefined : refusals.join('; '));

const strictClosedNode = (node: Json, path: string): string | undefined => {
  const keyword = refusedKeyword(node, STRICT_CLOSED_REFUSED_KEYWORDS, path);
  if (keyword !== undefined) return keyword;
  if (node['type'] !== 'object') return undefined;
  if (node['additionalProperties'] !== false) return `additionalProperties must be false (at ${path === '' ? '/' : path})`;
  const unknown = undeclaredRequired(node, path);
  if (unknown !== undefined) return unknown;
  const properties = isRecord(node['properties']) ? node['properties'] : {};
  const required = Array.isArray(node['required']) ? node['required'] : [];
  const missing = Object.keys(properties).find((name) => !required.includes(name));
  return missing === undefined ? undefined : `property ${missing} is not listed in required (at ${path === '' ? '/' : path})`;
};

const inlinedSubsetNode = (node: Json, path: string): string | undefined => {
  const keyword = refusedKeyword(node, INLINED_SUBSET_REFUSED_KEYWORDS, path);
  if (keyword !== undefined) return keyword;
  if (node['type'] === 'object' && !isRecord(node['properties'])) return `an object needs a properties map (at ${path === '' ? '/' : path})`;
  return undeclaredRequired(node, path);
};

export const strictClosedRefusalOf = (parameters: unknown): string | undefined => verdictOf(walk(parameters, '', strictClosedNode));

export const inlinedSubsetRefusalOf = (parameters: unknown): string | undefined => verdictOf(walk(parameters, '', inlinedSubsetNode));
