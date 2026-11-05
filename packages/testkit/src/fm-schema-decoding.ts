type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const TYPE_BEARING_KEYS = ['type', 'const', '$ref', 'anyOf'] as const;
const UNION_OBJECT_KEYS_WITH_PROPERTIES = ['x-order', 'additionalProperties', 'required'] as const;
const UNION_OBJECT_KEYS_WITHOUT_PROPERTIES = ['additionalProperties'] as const;

type RefusalKind = 'missing' | 'malformed' | 'guide';

type Context = { schemaName: string; guides: boolean };

class FmSchemaRefusal extends Error {
  readonly kind: RefusalKind;
  constructor(kind: RefusalKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const pathClause = (path: string): string => (path === '' ? '' : ` Path: ${path}.`);

const dataCorrupted = (path: string, description: string): FmSchemaRefusal =>
  new FmSchemaRefusal('malformed', `DecodingError.dataCorrupted: Data was corrupted.${pathClause(path)} Debug description: ${description}`);

const keyNotFound = (path: string, key: string): FmSchemaRefusal =>
  new FmSchemaRefusal(
    'missing',
    `DecodingError.keyNotFound: Key '${key}' not found in keyed decoding container.${pathClause(path)} Debug description: No value associated with key CodingKeys(stringValue: "${key}", intValue: nil) ("${key}").`,
  );

const childPath = (path: string, segment: string): string => (path === '' ? segment : `${path}.${segment}`);

type Region = { kind: 'plain'; definition: string; root: boolean } | { kind: 'union'; unionPath: string; within: string };

const UNSUPPORTED_GUIDE_MESSAGE = 'An unsupported generation guide was used.';

const unsupportedGuide = (): FmSchemaRefusal => new FmSchemaRefusal('guide', UNSUPPORTED_GUIDE_MESSAGE);

const undefinedReferences = (schemaName: string, reference: string): FmSchemaRefusal =>
  new FmSchemaRefusal(
    'malformed',
    `undefinedReferences(schema: Optional("${schemaName}"), references: ["${reference}"], context: FoundationModels.GenerationSchema.SchemaError.Context(debugDescription: "Undefined types: [${reference}]", underlyingErrors: []))`,
  );

const valueNotFound = (path: string, expected: string, description: string): FmSchemaRefusal =>
  new FmSchemaRefusal('malformed', `DecodingError.valueNotFound: Expected value of type ${expected}.${pathClause(path)} Debug description: ${description}`);

const typeMismatch = (path: string, expected: string, found: string): FmSchemaRefusal =>
  new FmSchemaRefusal(
    'malformed',
    `DecodingError.typeMismatch: Expected value of type ${expected}.${pathClause(path)} Debug description: Expected to decode ${expected} but found ${found} instead.`,
  );

const decodePlainObject = (node: Json, region: Extract<Region, { kind: 'plain' }>, context: Context): void => {
  const additionalPath = `$defs.${region.definition}.additionalProperties`;
  if (isRecord(node['properties'])) {
    if (isRecord(node['additionalProperties'])) throw typeMismatch(additionalPath, 'Bool', 'a dictionary');
    return;
  }
  if (region.root) return;
  if (isRecord(node['additionalProperties'])) throw undefinedReferences(context.schemaName, region.definition);
  throw typeMismatch(additionalPath, 'Dictionary<String, Any>', 'bool');
};

const childRegion = (region: Region, definitionSegment: string, within: string): Region =>
  region.kind === 'union'
    ? { kind: 'union', unionPath: region.unionPath, within: childPath(region.within, within) }
    : { kind: 'plain', definition: `${region.definition}_${definitionSegment}`, root: false };

const decodeUnion = (node: Json, branches: unknown[], path: string, context: Context): void => {
  const unionPath = childPath(path, 'anyOf');
  branches.forEach((branch, index) => decodeNode(branch, `${unionPath}[${index}]`, { kind: 'union', unionPath, within: '' }, context));
  if (!('title' in node)) throw dataCorrupted(path, "AnyOf schemas require a 'title' key");
};

const decodeUnionObject = (node: Json, path: string, region: Extract<Region, { kind: 'union' }>): void => {
  const keys = isRecord(node['properties']) ? UNION_OBJECT_KEYS_WITH_PROPERTIES : UNION_OBJECT_KEYS_WITHOUT_PROPERTIES;
  for (const key of keys) {
    if (!(key in node)) throw keyNotFound(path, key);
  }
  if (!isRecord(node['properties'])) throw typeMismatch(`${path}.additionalProperties`, 'Dictionary<String, Any>', 'bool');
  if (isRecord(node['additionalProperties'])) throw typeMismatch(`${path}.additionalProperties`, 'Bool', 'a dictionary');
  if (!('title' in node)) throw dataCorrupted(titlePathOf(region), "Object schemas require a 'title' key");
};

const titlePathOf = (region: Extract<Region, { kind: 'union' }>): string => (region.within === '' ? region.unionPath : childPath(region.unionPath, region.within));

const decodeOrder = (node: Json, path: string): void => {
  const order = node['x-order'];
  if (!Array.isArray(order)) return;
  const properties = isRecord(node['properties']) ? node['properties'] : {};
  for (const name of order) {
    if (typeof name === 'string' && !(name in properties)) {
      throw dataCorrupted(childPath(childPath(path, 'properties'), name), `Missing property '${name}' in x-order`);
    }
  }
};

const decodeTyped = (node: Json, path: string, context: Context, region: Region): void => {
  if (Array.isArray(node['type'])) throw typeMismatch(`${path}.type`, 'String', 'an array');
  if (node['type'] === 'string' && Array.isArray(node['enum'])) {
    const index = node['enum'].indexOf(null);
    if (index >= 0) throw valueNotFound(`${childPath(path, 'enum')}[${index}]`, 'String', 'Cannot get value of type String -- found null value instead');
  }
  if (context.guides && region.kind === 'plain' && 'pattern' in node) throw unsupportedGuide();
};

const decodeNode = (node: unknown, path: string, region: Region, context: Context): void => {
  if (!isRecord(node)) return;
  if (!TYPE_BEARING_KEYS.some((key) => key in node)) {
    throw dataCorrupted(path, `None of these keys were present: ${TYPE_BEARING_KEYS.map((key) => `'${key}'`).join(', ')}`);
  }
  if (typeof node['$ref'] === 'string') throw undefinedReferences(context.schemaName, node['$ref'].split('/').at(-1) ?? node['$ref']);
  const branches = node['anyOf'];
  if (Array.isArray(branches)) {
    decodeUnion(node, branches, path, context);
    return;
  }
  decodeTyped(node, path, context, region);
  if (node['type'] === 'object') {
    if (region.kind === 'union') decodeUnionObject(node, path, region);
    else decodePlainObject(node, region, context);
  }
  decodeOrder(node, region.kind === 'union' && region.within === '' ? region.unionPath : path);
  const properties = node['properties'];
  if (isRecord(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      decodeNode(child, childPath(childPath(path, 'properties'), name), childRegion(region, name, childPath('properties', name)), context);
    }
  }
  if ('items' in node) decodeNode(node['items'], childPath(path, 'items'), childRegion(region, 'item', 'items'), context);
};

const refusalOf = (schema: unknown, region: Region, context: Context): FmSchemaRefusal | undefined => {
  try {
    decodeNode(schema, '', region, context);
    return undefined;
  } catch (error) {
    if (error instanceof FmSchemaRefusal) return error;
    throw error;
  }
};

export type FmRefusalReply = { status: 400 | 500; message: string };

const definitionNameOf = (schemaName: string, schema: unknown): string => (isRecord(schema) && typeof schema['title'] === 'string' ? schema['title'] : schemaName);

export const fmSchemaRefusalOf = (schemaName: string, schema: unknown): FmRefusalReply | undefined => {
  const definition = definitionNameOf(schemaName, schema);
  const refusal = refusalOf(schema, { kind: 'plain', definition, root: true }, { schemaName: definition, guides: true });
  if (refusal === undefined) return undefined;
  return refusal.kind === 'guide' ? { status: 500, message: refusal.message } : { status: 400, message: `Invalid response_format schema: ${refusal.message}` };
};

const NATIVE_REFUSAL_TEXT: Record<Exclude<RefusalKind, 'guide'>, string> = {
  missing: 'The data couldn’t be read because it is missing.',
  malformed: 'The data couldn’t be read because it isn’t in the correct format.',
};

export const fmToolsRefusalOf = (tools: readonly unknown[]): string | undefined => {
  for (const tool of tools) {
    const fn = isRecord(tool) && isRecord(tool['function']) ? tool['function'] : {};
    if (!('parameters' in fn)) return `Invalid JSON: ${NATIVE_REFUSAL_TEXT.missing}`;
    const name = String(fn['name']);
    const refusal = refusalOf(fn['parameters'], { kind: 'plain', definition: name, root: false }, { schemaName: name, guides: false });
    if (refusal !== undefined && refusal.kind !== 'guide') return `Invalid request: ${NATIVE_REFUSAL_TEXT[refusal.kind]}`;
  }
  return undefined;
};
