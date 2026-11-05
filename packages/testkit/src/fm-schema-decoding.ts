type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const TYPE_BEARING_KEYS = ['type', 'const', '$ref', 'anyOf'] as const;
const UNION_OBJECT_KEYS_WITH_PROPERTIES = ['x-order', 'additionalProperties', 'required'] as const;
const UNION_OBJECT_KEYS_WITHOUT_PROPERTIES = ['additionalProperties'] as const;

type RefusalKind = 'missing' | 'malformed';

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

type Region = { kind: 'plain'; definition: string; root: boolean } | { kind: 'union'; branchOf: string | undefined };

const typeMismatch = (path: string, expected: string, found: string): FmSchemaRefusal =>
  new FmSchemaRefusal(
    'malformed',
    `DecodingError.typeMismatch: Expected value of type ${expected}.${pathClause(path)} Debug description: Expected to decode ${expected} but found ${found} instead.`,
  );

const decodePlainObject = (node: Json, region: Extract<Region, { kind: 'plain' }>): void => {
  if (region.root || isRecord(node['properties']) || 'additionalProperties' in node) return;
  throw typeMismatch(`$defs.${region.definition}.additionalProperties`, 'Dictionary<String, Any>', 'bool');
};

const childRegion = (region: Region, segment: string): Region =>
  region.kind === 'union' ? { kind: 'union', branchOf: undefined } : { kind: 'plain', definition: `${region.definition}_${segment}`, root: false };

const decodeUnion = (node: Json, branches: unknown[], path: string): void => {
  const unionPath = childPath(path, 'anyOf');
  branches.forEach((branch, index) => decodeNode(branch, `${unionPath}[${index}]`, { kind: 'union', branchOf: unionPath }));
  if (!('title' in node)) throw dataCorrupted(path, "AnyOf schemas require a 'title' key");
};

const decodeUnionObject = (node: Json, path: string, branchOf: string | undefined): void => {
  const keys = isRecord(node['properties']) ? UNION_OBJECT_KEYS_WITH_PROPERTIES : UNION_OBJECT_KEYS_WITHOUT_PROPERTIES;
  for (const key of keys) {
    if (!(key in node)) throw keyNotFound(path, key);
  }
  if (branchOf !== undefined && !('title' in node)) throw dataCorrupted(branchOf, "Object schemas require a 'title' key");
};

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

const decodeNode = (node: unknown, path: string, region: Region): void => {
  if (!isRecord(node)) return;
  if (!TYPE_BEARING_KEYS.some((key) => key in node)) {
    throw dataCorrupted(path, `None of these keys were present: ${TYPE_BEARING_KEYS.map((key) => `'${key}'`).join(', ')}`);
  }
  const branches = node['anyOf'];
  if (Array.isArray(branches)) {
    decodeUnion(node, branches, path);
    return;
  }
  const branchOf = region.kind === 'union' ? region.branchOf : undefined;
  if (node['type'] === 'object') {
    if (region.kind === 'union') decodeUnionObject(node, path, branchOf);
    else decodePlainObject(node, region);
  }
  decodeOrder(node, branchOf ?? path);
  const properties = node['properties'];
  if (isRecord(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      decodeNode(child, childPath(childPath(path, 'properties'), name), childRegion(region, name));
    }
  }
  if ('items' in node) decodeNode(node['items'], childPath(path, 'items'), childRegion(region, 'item'));
};

const refusalOf = (schema: unknown, region: Region): FmSchemaRefusal | undefined => {
  try {
    decodeNode(schema, '', region);
    return undefined;
  } catch (error) {
    if (error instanceof FmSchemaRefusal) return error;
    throw error;
  }
};

export const fmSchemaRefusalOf = (schemaName: string, schema: unknown): string | undefined => {
  const refusal = refusalOf(schema, { kind: 'plain', definition: schemaName, root: true });
  return refusal === undefined ? undefined : `Invalid response_format schema: ${refusal.message}`;
};

const NATIVE_REFUSAL_TEXT: Record<RefusalKind, string> = {
  missing: 'The data couldn’t be read because it is missing.',
  malformed: 'The data couldn’t be read because it isn’t in the correct format.',
};

export const fmToolsRefusalOf = (tools: readonly unknown[]): string | undefined => {
  for (const tool of tools) {
    const fn = isRecord(tool) && isRecord(tool['function']) ? tool['function'] : {};
    if (!('parameters' in fn)) return `Invalid JSON: ${NATIVE_REFUSAL_TEXT.missing}`;
    const refusal = refusalOf(fn['parameters'], { kind: 'plain', definition: String(fn['name']), root: false });
    if (refusal !== undefined) return `Invalid request: ${NATIVE_REFUSAL_TEXT[refusal.kind]}`;
  }
  return undefined;
};
