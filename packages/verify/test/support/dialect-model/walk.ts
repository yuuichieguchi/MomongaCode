import { isObject, type Json, type JsonObject } from './json.ts';

const MAP_KEYWORDS: ReadonlySet<string> = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']);
const ARRAY_KEYWORDS: ReadonlySet<string> = new Set(['prefixItems', 'anyOf', 'oneOf', 'allOf']);
const SINGLE_KEYWORDS: ReadonlySet<string> = new Set([
  'items',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
]);

export const SAME_LOCATION_EDGES: readonly string[] = ['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', 'dependentSchemas'];

export const NODE_EDGES: readonly string[] = [
  'properties', 'patternProperties', 'items', 'prefixItems', 'anyOf', 'allOf', 'oneOf', 'then', 'else', 'dependentSchemas', '$defs', 'definitions',
];

export interface ChildSlot {
  edge: string;
  segments: string[];
  holder: JsonObject | Json[];
  key: string | number;
}

export const childSlots = (node: JsonObject): ChildSlot[] => {
  const slots: ChildSlot[] = [];
  for (const keyword of Object.keys(node)) {
    const value = node[keyword];
    if (MAP_KEYWORDS.has(keyword) && isObject(value)) {
      for (const name of Object.keys(value)) slots.push({ edge: keyword, segments: [keyword, name], holder: value, key: name });
    } else if (ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) {
      value.forEach((_, index) => slots.push({ edge: keyword, segments: [keyword, String(index)], holder: value, key: index }));
    } else if (SINGLE_KEYWORDS.has(keyword) && (isObject(value) || typeof value === 'boolean')) {
      slots.push({ edge: keyword, segments: [keyword], holder: node, key: keyword });
    }
  }
  return slots;
};

export const labelStep = (slot: ChildSlot): string => (slot.edge === 'properties' ? String(slot.key) : slot.segments.join('_'));

export const slotValue = (slot: ChildSlot): Json =>
  Array.isArray(slot.holder) ? (slot.holder[slot.key as number] as Json) : (slot.holder[slot.key as string] as Json);

export const setSlot = (slot: ChildSlot, value: Json): void => {
  if (Array.isArray(slot.holder)) slot.holder[slot.key as number] = value;
  else slot.holder[slot.key as string] = value;
};

export const collectReferenceSegments = (document: Json | undefined): Set<string> => {
  const segments = new Set<string>();
  const visit = (value: Json | undefined): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isObject(value)) return;
    const reference = value['$ref'];
    if (typeof reference === 'string' && reference.startsWith('#')) {
      for (const segment of reference.slice(1).split('/')) {
        if (segment !== '') segments.add(decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~'));
      }
    }
    for (const key of Object.keys(value)) visit(value[key]);
  };
  visit(document);
  return segments;
};
