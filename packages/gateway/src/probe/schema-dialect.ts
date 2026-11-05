import type { Capabilities } from '@momonga/protocol';
import { isRecord, type JsonObject } from './json.ts';
import { lowerSchema, typeFromLiterals, type KeywordSupport } from './lowering.ts';

export type SchemaDialect = Capabilities['schemaDialect'];

export const FM_SCHEMA_DIALECT: SchemaDialect = 'guided-generation';

const ROOT_TITLE = 'root';

const titleOf = (path: string): string => (path === '' ? ROOT_TITLE : path);

const childPath = (path: string, segment: string): string => (path === '' ? segment : `${path}_${segment}`);

const hasTypeBearingKey = (node: JsonObject): boolean => ['type', 'const', '$ref', 'anyOf'].some((key) => key in node);

const inferredTypeOf = (node: JsonObject): string | string[] | undefined => {
  if (Array.isArray(node['enum'])) return typeFromLiterals(node['enum']);
  if (isRecord(node['properties'])) return 'object';
  if ('items' in node) return 'array';
  return undefined;
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

const guideNode = (node: unknown, path: string, directBranch: boolean): unknown => {
  if (!isRecord(node)) return node;
  const branches = node['anyOf'];
  if (Array.isArray(branches)) {
    return {
      ...node,
      anyOf: branches.map((branch, index) => guideNode(branch, childPath(path, String(index)), true)),
      title: node['title'] ?? titleOf(path),
    };
  }
  const typed: JsonObject = hasTypeBearingKey(node) ? node : { ...node, ...(inferredTypeOf(node) === undefined ? {} : { type: inferredTypeOf(node) }) };
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
  readonly guaranteedKeywords: Partial<KeywordSupport>;
  readonly addRequiredKeys: (schema: JsonObject) => JsonObject;
  readonly parametersWhenAbsent: JsonObject | undefined;
};

const RENDERERS: Record<SchemaDialect, DialectRenderer> = {
  'json-schema-2020-12': { guaranteedKeywords: {}, addRequiredKeys: (schema) => schema, parametersWhenAbsent: undefined },
  'guided-generation': {
    guaranteedKeywords: { enum: true, anyOf: true },
    addRequiredKeys: guidedGeneration,
    parametersWhenAbsent: { type: 'object' },
  },
};

export const supportIn = (dialect: SchemaDialect, support: KeywordSupport): KeywordSupport => ({
  ...support,
  ...RENDERERS[dialect].guaranteedKeywords,
});

export const renderSchema = (schema: JsonObject, dialect: SchemaDialect, support: KeywordSupport): JsonObject =>
  RENDERERS[dialect].addRequiredKeys(lowerSchema(schema, supportIn(dialect, support)));

export const renderAssembled = (schema: JsonObject, dialect: SchemaDialect): JsonObject => RENDERERS[dialect].addRequiredKeys(schema);

export const renderParameters = (
  parameters: JsonObject | null | undefined,
  dialect: SchemaDialect,
  support: KeywordSupport,
): JsonObject | undefined => {
  const source = parameters ?? RENDERERS[dialect].parametersWhenAbsent;
  return source === undefined ? undefined : renderSchema(source, dialect, support);
};
