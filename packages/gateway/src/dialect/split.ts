import { ANNOTATION_KEYS, DOCUMENT_KEYS, deepEqual, isVocabularyKey, jsonTypeOf, matchesType, typesOf, vocabularyOf } from './schema.ts';
import type { JsonObject } from './schema.ts';
import { fail, guardWrittenKeys } from './state.ts';
import type { NodeContext, RenderState } from './state.ts';

const unionParent = (state: RenderState, node: JsonObject, branches: JsonObject[]): JsonObject => {
  const parent: JsonObject = {};
  for (const [key, value] of Object.entries(node)) if (ANNOTATION_KEYS.has(key) || DOCUMENT_KEYS.has(key)) parent[key] = value;
  parent['anyOf'] = branches;
  state.synthetic.add(parent);
  return parent;
};

const branchKeys = (node: JsonObject, type: string, own: readonly string[]): [string, unknown][] => {
  const vocabulary = vocabularyOf(type);
  return Object.entries(node)
    .filter(([key]) => !own.includes(key) && !DOCUMENT_KEYS.has(key))
    .filter(([key]) => !isVocabularyKey(key) || vocabulary.has(key))
    .map(([key, value]): [string, unknown] => [key, structuredClone(value)]);
};

const typeGroups = (values: readonly unknown[]): Map<string, unknown[]> => {
  const types = values.map(jsonTypeOf);
  const numeric = types.includes('number');
  const groups = new Map<string, unknown[]>();
  values.forEach((value, index) => {
    const raw = types[index] as string;
    const type = numeric && raw === 'integer' ? 'number' : raw;
    groups.set(type, [...(groups.get(type) ?? []), value]);
  });
  return groups;
};

export const splitEnum = (state: RenderState, node: JsonObject, context: NodeContext): JsonObject => {
  const values = node['enum'];
  if (!Array.isArray(values)) return node;
  const allowed = typesOf(node);
  const kept = allowed === undefined ? values : values.filter((value) => allowed.some((type) => matchesType(value, type)));
  if (kept.length === 0) return fail(state, 'unsatisfiable', context.origin, 'no enum value has a type the node allows');
  const groups = typeGroups(kept);
  if (groups.size <= 1) {
    if (kept.length === values.length) return node;
    guardWrittenKeys(state, ['enum'], 'split-enum');
    return { ...node, enum: kept };
  }
  guardWrittenKeys(state, ['type', 'enum', 'anyOf'], 'split-enum');
  const branches = [...groups].map(([type, group]): JsonObject => ({ type, enum: group, ...Object.fromEntries(branchKeys(node, type, ['type', 'enum'])) }));
  return unionParent(state, node, branches);
};

export const splitTypeArray = (state: RenderState, node: JsonObject, context: NodeContext): JsonObject => {
  if (!Array.isArray(node['type'])) return node;
  const types = [...new Set(typesOf(node))];
  guardWrittenKeys(state, ['type', 'anyOf'], 'split-type-array');
  const branches: JsonObject[] = [];
  for (const type of types) {
    const branch: JsonObject = { type };
    if ('const' in node) {
      if (!matchesType(node['const'], type)) continue;
      branch['const'] = structuredClone(node['const']);
    }
    const values = node['enum'];
    if (Array.isArray(values)) {
      const kept = values.filter((value) => matchesType(value, type));
      if (kept.length === 0) continue;
      branch['enum'] = structuredClone(kept);
    }
    for (const [key, value] of branchKeys(node, type, ['type', 'enum', 'const'])) branch[key] = value;
    branches.push(branch);
  }
  if (branches.length === 0) return fail(state, 'unsatisfiable', context.origin, 'no branch of the type array can hold a value');
  return unionParent(state, node, branches);
};

export const constAsEnum = (state: RenderState, node: JsonObject, context: NodeContext): JsonObject => {
  if (!('const' in node)) return node;
  const value = node['const'];
  const values = node['enum'];
  if (Array.isArray(values) && !values.some((candidate) => deepEqual(candidate, value))) {
    return fail(state, 'unsatisfiable', context.origin, 'the const value is not in the enum');
  }
  guardWrittenKeys(state, ['const', 'enum'], 'const-as-enum');
  const { const: _removed, ...rest } = node;
  return { ...rest, enum: [value] };
};
