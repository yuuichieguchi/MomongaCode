import { isRecord } from '@momonga/foundation';

export type JsonObject = Record<string, unknown>;

export { isRecord };

export type Position = 'positive' | 'negative' | 'mixed';

export const OBJECT_VOCABULARY: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  'additionalProperties',
  'required',
  'propertyNames',
  'minProperties',
  'maxProperties',
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedProperties',
]);

export const ARRAY_VOCABULARY: ReadonlySet<string> = new Set([
  'items',
  'prefixItems',
  'contains',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minContains',
  'maxContains',
  'unevaluatedItems',
  'additionalItems',
]);

export const STRING_VOCABULARY: ReadonlySet<string> = new Set([
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
]);

export const NUMERIC_VOCABULARY: ReadonlySet<string> = new Set(['multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum']);

export const ANNOTATION_KEYS: ReadonlySet<string> = new Set(['title', 'description', 'default', 'deprecated', 'readOnly', 'writeOnly', 'examples', '$comment']);

export const DOCUMENT_KEYS: ReadonlySet<string> = new Set(['$schema', '$id', '$defs', 'definitions', '$anchor', '$dynamicAnchor', '$vocabulary']);

export const APPLICATOR_KEYS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  'additionalProperties',
  'items',
  'prefixItems',
  'additionalItems',
  'contains',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'dependencies',
  '$ref',
  '$dynamicRef',
  '$recursiveRef',
]);

export const IN_PLACE_KEYWORDS: ReadonlySet<string> = new Set(['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', 'dependentSchemas', 'dependencies']);

export const VALUE_POSITION_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  'items',
  'prefixItems',
  'anyOf',
  'allOf',
  'oneOf',
  'then',
  'else',
  'dependentSchemas',
  '$defs',
  'definitions',
]);

const ALL_VOCABULARIES: readonly ReadonlySet<string>[] = [OBJECT_VOCABULARY, ARRAY_VOCABULARY, STRING_VOCABULARY, NUMERIC_VOCABULARY];

export const isVocabularyKey = (key: string): boolean => ALL_VOCABULARIES.some((vocabulary) => vocabulary.has(key));

export const vocabularyOf = (type: string): ReadonlySet<string> => {
  switch (type) {
    case 'object':
      return OBJECT_VOCABULARY;
    case 'array':
      return ARRAY_VOCABULARY;
    case 'string':
      return STRING_VOCABULARY;
    case 'integer':
    case 'number':
      return NUMERIC_VOCABULARY;
    default:
      return new Set();
  }
};

export const jsonTypeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (Array.isArray(value)) return 'array';
  return 'object';
};

export const matchesType = (value: unknown, type: string): boolean => {
  const actual = jsonTypeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
};

export const deepEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]));
  if (isRecord(left)) {
    if (!isRecord(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
};

export const typesOf = (node: JsonObject): readonly string[] | undefined => {
  const type = node['type'];
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((entry): entry is string => typeof entry === 'string');
  return undefined;
};

export const typeIncludes = (node: JsonObject, type: string): boolean => typesOf(node)?.includes(type) ?? false;

export const escapePointerSegment = (segment: string): string => segment.replaceAll('~', '~0').replaceAll('/', '~1');

const unescapePointerSegment = (segment: string): string => segment.replaceAll('~1', '/').replaceAll('~0', '~');

export const pointerSegments = (pointer: string): string[] => (pointer === '' ? [] : pointer.slice(1).split('/').map(unescapePointerSegment));

export const resolvePointer = (root: unknown, pointer: string): unknown => {
  let node: unknown = root;
  for (const segment of pointerSegments(pointer)) {
    if (Array.isArray(node)) {
      node = node[Number(segment)];
    } else if (isRecord(node) && Object.hasOwn(node, segment)) {
      node = node[segment];
    } else {
      return undefined;
    }
  }
  return node;
};

export type ChildEntry = { keyword: string; key: string | undefined; value: unknown };

const SINGLE_CHILD_KEYWORDS = ['unevaluatedProperties', 'unevaluatedItems', 'additionalItems', 'propertyNames', 'contains'] as const;
const TAIL_SINGLE_KEYWORDS = ['not', 'if', 'then', 'else'] as const;
const ARRAY_CHILD_KEYWORDS = ['prefixItems', 'anyOf', 'allOf', 'oneOf'] as const;
const MAP_CHILD_KEYWORDS = ['dependentSchemas', 'dependencies', '$defs', 'definitions'] as const;

const isSchema = (value: unknown): boolean => typeof value === 'boolean' || isRecord(value);

export const childrenOf = (node: JsonObject): ChildEntry[] => {
  const children: ChildEntry[] = [];
  const mapChildren = (keyword: string): void => {
    const map = node[keyword];
    if (!isRecord(map)) return;
    for (const [key, value] of Object.entries(map)) if (isSchema(value)) children.push({ keyword, key, value });
  };
  mapChildren('properties');
  mapChildren('patternProperties');
  if (isSchema(node['additionalProperties'])) children.push({ keyword: 'additionalProperties', key: undefined, value: node['additionalProperties'] });
  const items = node['items'];
  if (Array.isArray(items)) items.forEach((value, index) => children.push({ keyword: 'items', key: String(index), value }));
  else if (isSchema(items)) children.push({ keyword: 'items', key: undefined, value: items });
  for (const keyword of SINGLE_CHILD_KEYWORDS) {
    if (isSchema(node[keyword])) children.push({ keyword, key: undefined, value: node[keyword] });
  }
  for (const keyword of ARRAY_CHILD_KEYWORDS) {
    const list = node[keyword];
    if (Array.isArray(list)) list.forEach((value, index) => children.push({ keyword, key: String(index), value }));
  }
  for (const keyword of TAIL_SINGLE_KEYWORDS) {
    if (isSchema(node[keyword])) children.push({ keyword, key: undefined, value: node[keyword] });
  }
  for (const keyword of MAP_CHILD_KEYWORDS) mapChildren(keyword);
  return children;
};

export const assignChild = (node: JsonObject, child: ChildEntry, value: unknown): void => {
  const container = node[child.keyword];
  if (child.key === undefined) {
    node[child.keyword] = value;
  } else if (Array.isArray(container)) {
    container[Number(child.key)] = value;
  } else if (isRecord(container)) {
    container[child.key] = value;
  }
};

export const mapChildren = (node: JsonObject, transform: (child: ChildEntry) => unknown): JsonObject => {
  const copy: JsonObject = { ...node };
  for (const keyword of Object.keys(copy)) {
    const value = copy[keyword];
    if (Array.isArray(value) && (ARRAY_CHILD_KEYWORDS as readonly string[]).includes(keyword)) copy[keyword] = [...value];
    else if (isRecord(value) && (keyword === 'properties' || keyword === 'patternProperties' || (MAP_CHILD_KEYWORDS as readonly string[]).includes(keyword))) copy[keyword] = { ...value };
  }
  if (Array.isArray(copy['items'])) copy['items'] = [...copy['items']];
  for (const child of childrenOf(copy)) assignChild(copy, child, transform(child));
  return copy;
};

export const stepPosition = (keyword: string, parent: JsonObject): Position => {
  switch (keyword) {
    case 'not':
      return 'negative';
    case 'oneOf':
    case 'if':
      return 'mixed';
    case 'contains':
      return 'maxContains' in parent ? 'mixed' : 'positive';
    default:
      return 'positive';
  }
};

export const composePosition = (outer: Position, inner: Position): Position => {
  if (outer === 'mixed' || inner === 'mixed') return 'mixed';
  return outer === inner ? 'positive' : 'negative';
};

export const joinPosition = (left: Position, right: Position): Position => (left === right ? left : 'mixed');

export const unevaluatedPropertiesActive = (node: JsonObject): boolean => node['unevaluatedProperties'] !== undefined && node['unevaluatedProperties'] !== true;

export const unevaluatedActive = (node: JsonObject): boolean =>
  unevaluatedPropertiesActive(node) || (node['unevaluatedItems'] !== undefined && node['unevaluatedItems'] !== true);
