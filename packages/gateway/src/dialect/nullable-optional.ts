import type { Segment } from '@momonga/protocol';
import { childrenOf, escapePointerSegment, isRecord } from './schema.ts';
import type { JsonObject } from './schema.ts';
import { fail } from './state.ts';
import type { NodeContext, RenderState } from './state.ts';

const NULL_SCHEMA: JsonObject = { type: 'null' };

const SCHEMA_ESCAPES = ['$ref', '$dynamicRef', 'allOf', 'oneOf', 'not', 'if'] as const;

export const admitsNull = (schema: unknown): boolean => {
  if (schema === true) return true;
  if (schema === false) return false;
  if (!isRecord(schema)) return true;
  if (SCHEMA_ESCAPES.some((key) => key in schema)) return true;
  const type = schema['type'];
  if (type !== undefined && !(type === 'null' || (Array.isArray(type) && type.includes('null')))) return false;
  const values = schema['enum'];
  if (values !== undefined && !(Array.isArray(values) && values.some((value) => value === null))) return false;
  if ('const' in schema && schema['const'] !== null) return false;
  const branches = schema['anyOf'];
  if (branches !== undefined && !(Array.isArray(branches) && branches.some(admitsNull))) return false;
  return true;
};

const PRESENCE_OBSERVERS = ['minProperties', 'maxProperties', 'dependentRequired', 'dependentSchemas', 'patternProperties', 'allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', 'not', '$ref', '$dynamicRef'] as const;

const wrapNeeded = (object: JsonObject): string[] => {
  const properties = object['properties'];
  if (!isRecord(properties)) return [];
  const required = Array.isArray(object['required']) ? object['required'] : [];
  return Object.entries(properties)
    .filter(([name, schema]) => !required.includes(name) && !admitsNull(schema))
    .map(([name]) => name);
};

export const nullableOptional = (state: RenderState, root: JsonObject, _context: NodeContext): JsonObject => {
  const tool = state.site.kind === 'tool-parameters' ? state.site.tool : undefined;
  if (tool === undefined) return root;
  const wrapped: { at: Segment[]; property: string }[] = [];
  const walk = (node: JsonObject, aligned: boolean, at: Segment[], origin: string): void => {
    const names = wrapNeeded(node);
    if (names.length > 0) {
      if (!aligned) fail(state, 'inverse-ambiguous', origin, 'an optional property below this keyword has no unambiguous inverse');
      if (PRESENCE_OBSERVERS.some((key) => key in node)) fail(state, 'dependency', origin, 'a keyword of this object observes which properties are present');
      const properties = node['properties'] as JsonObject;
      for (const name of names) {
        const wrapper: JsonObject = { anyOf: [properties[name], { ...NULL_SCHEMA }] };
        state.wrappers.add(wrapper);
        properties[name] = wrapper;
        wrapped.push({ at: [...at], property: name });
      }
    }
    for (const child of childrenOf(node)) {
      const childOrigin = `${origin}/${child.keyword}${child.key === undefined ? '' : `/${escapePointerSegment(child.key)}`}`;
      const original = isRecord(child.value) && state.wrappers.has(child.value) ? (child.value['anyOf'] as unknown[])[0] : child.value;
      if (!isRecord(original)) continue;
      if (child.keyword === 'properties' && child.key !== undefined) walk(original, aligned, [...at, { property: child.key }], childOrigin);
      else if (child.keyword === 'items' && child.key === undefined) walk(original, aligned, [...at, { items: true }], childOrigin);
      else walk(original, false, at, childOrigin);
    }
  };
  walk(root, true, [], '');
  if (wrapped.length > 0) state.wraps.push({ tool, wrapped });
  return root;
};
