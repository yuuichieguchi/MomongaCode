import type { Capabilities } from '@momonga/protocol';
import { isRecord, type JsonObject } from './json.ts';
import { literalTypeOf, lowerSchema, typeFromLiterals, type KeywordSupport } from './lowering.ts';

export type SchemaDialect = Capabilities['schemaDialect'];

export const FM_SCHEMA_DIALECT: SchemaDialect = 'guided-generation';

const ROOT_TITLE = 'root';

const titleOf = (path: string): string => (path === '' ? ROOT_TITLE : path);

const childPath = (path: string, segment: string): string => (path === '' ? segment : `${path}_${segment}`);

const hasTypeBearingKey = (node: JsonObject): boolean => ['type', 'const', '$ref', 'anyOf'].some((key) => key in node);

const enumTypeGroups = (values: readonly unknown[]): Map<string, unknown[]> => {
  const literalTypes = values.map(literalTypeOf);
  const numberLike = literalTypes.includes('number');
  const groups = new Map<string, unknown[]>();
  values.forEach((value, index) => {
    const literalType = literalTypes[index] as string;
    const type = numberLike && literalType === 'integer' ? 'number' : literalType;
    groups.set(type, [...(groups.get(type) ?? []), value]);
  });
  return groups;
};

const mixedEnumAsUnion = (node: JsonObject, values: readonly unknown[], path: string): JsonObject => {
  const { enum: _values, ...rest } = node;
  return {
    ...rest,
    anyOf: [...enumTypeGroups(values)].map(([type, group]) => ({ type, enum: group, title: childPath(path, type) })),
  };
};

const typedNode = (node: JsonObject, path: string): JsonObject => {
  if (hasTypeBearingKey(node)) return node;
  const values = node['enum'];
  if (Array.isArray(values)) {
    const type = typeFromLiterals(values);
    return typeof type === 'string' ? { ...node, type } : mixedEnumAsUnion(node, values, path);
  }
  if (isRecord(node['properties']) || path === '') return { ...node, type: 'object' };
  if ('items' in node) return { ...node, type: 'array' };
  return { ...node, type: 'string' };
};

const guideObject = (node: JsonObject, path: string): JsonObject => {
  const properties = isRecord(node['properties']) ? node['properties'] : {};
  const additional = node['additionalProperties'];
  return {
    ...node,
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, child]) => [name, guideNode(child, childPath(path, name), false)]),
    ),
    'x-order': Object.keys(properties),
    additionalProperties: additional !== undefined && additional !== false,
    required: Array.isArray(node['required']) ? node['required'] : [],
  };
};

const guideUnion = (node: JsonObject, branches: readonly unknown[], path: string): JsonObject => ({
  ...node,
  anyOf: branches.map((branch, index) => guideNode(branch, childPath(path, String(index)), true)),
  title: node['title'] ?? titleOf(path),
});

const guideNode = (node: unknown, path: string, directBranch: boolean): unknown => {
  if (node === true) return guideNode({}, path, directBranch);
  if (!isRecord(node)) return node;
  const typed = typedNode(node, path);
  const branches = typed['anyOf'];
  if (Array.isArray(branches)) return guideUnion(typed, branches, path);
  const shaped: JsonObject = typed['type'] === 'object' ? guideObject(typed, path) : { ...typed };
  if (shaped['type'] === 'object' && directBranch) shaped['title'] ??= titleOf(path);
  if ('items' in shaped) shaped['items'] = guideNode(shaped['items'], childPath(path, 'items'), false);
  return shaped;
};

const guidedGeneration = (schema: JsonObject): JsonObject => {
  const guided = guideNode(schema, '', false);
  return isRecord(guided) ? guided : schema;
};

type DialectRenderer = {
  readonly addRequiredKeys: (schema: JsonObject) => JsonObject;
  readonly parametersWhenAbsent: JsonObject | undefined;
};

const RENDERERS: Record<SchemaDialect, DialectRenderer> = {
  'json-schema-2020-12': { addRequiredKeys: (schema) => schema, parametersWhenAbsent: undefined },
  'guided-generation': { addRequiredKeys: guidedGeneration, parametersWhenAbsent: { type: 'object' } },
};

export const renderSchema = (schema: JsonObject, dialect: SchemaDialect, support: KeywordSupport): JsonObject =>
  RENDERERS[dialect].addRequiredKeys(lowerSchema(schema, support));

export const renderAssembled = (schema: JsonObject, dialect: SchemaDialect): JsonObject => RENDERERS[dialect].addRequiredKeys(schema);

export const renderParameters = (
  parameters: JsonObject | null | undefined,
  dialect: SchemaDialect,
  support: KeywordSupport,
): JsonObject | undefined => {
  const source = parameters ?? RENDERERS[dialect].parametersWhenAbsent;
  return source === undefined ? undefined : renderSchema(source, dialect, support);
};
