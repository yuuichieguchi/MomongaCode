export type JsonSchema = { [key: string]: unknown };

export interface InstancePreferences {
  requiredToolName?: string;
}

const isRecord = (value: unknown): value is JsonSchema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const allowedValues = (schema: unknown): unknown[] => {
  if (!isRecord(schema)) return [];
  if ('const' in schema) return [schema['const']];
  if (Array.isArray(schema['enum'])) return schema['enum'];
  return [];
};

const branchScore = (branch: unknown, preferences: InstancePreferences): number => {
  if (!isRecord(branch) || !isRecord(branch['properties'])) return 0;
  const properties = branch['properties'];
  let score = 0;
  const kinds = allowedValues(properties['kind']);
  const wantsTool = preferences.requiredToolName !== undefined;
  if (kinds.includes('tool_calls')) score += wantsTool ? 2 : -2;
  if (kinds.includes('final')) score += wantsTool ? -2 : 2;
  const names = allowedValues(properties['name']);
  if (wantsTool && names.includes(preferences.requiredToolName)) score += 4;
  return score;
};

const pickBranch = (branches: unknown[], preferences: InstancePreferences): unknown => {
  let best = branches[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const branch of branches) {
    const score = branchScore(branch, preferences);
    if (score > bestScore) {
      best = branch;
      bestScore = score;
    }
  }
  return best;
};

const pickAllowed = (values: unknown[], preferences: InstancePreferences): unknown => {
  if (preferences.requiredToolName !== undefined && values.includes(preferences.requiredToolName)) {
    return preferences.requiredToolName;
  }
  return values[0];
};

const typeOf = (schema: JsonSchema): string | undefined => {
  const type = schema['type'];
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.find((entry) => entry !== 'null') ?? type[0];
  if (isRecord(schema['properties'])) return 'object';
  if (schema['items'] !== undefined) return 'array';
  return undefined;
};

const numberIn = (schema: JsonSchema, integer: boolean): number => {
  const minimum = typeof schema['minimum'] === 'number' ? schema['minimum'] : undefined;
  const maximum = typeof schema['maximum'] === 'number' ? schema['maximum'] : undefined;
  let value = minimum ?? (maximum !== undefined ? Math.min(0, maximum) : 1);
  if (integer) value = Math.ceil(value);
  return value;
};

export const generateInstance = (schema: unknown, preferences: InstancePreferences = {}): unknown => {
  if (!isRecord(schema)) return null;
  const allowed = allowedValues(schema);
  if (allowed.length > 0) return pickAllowed(allowed, preferences);
  for (const combinator of ['anyOf', 'oneOf']) {
    const branches = schema[combinator];
    if (Array.isArray(branches) && branches.length > 0) {
      return generateInstance(pickBranch(branches, preferences), preferences);
    }
  }
  switch (typeOf(schema)) {
    case 'object': {
      const properties = isRecord(schema['properties']) ? schema['properties'] : {};
      const result: Record<string, unknown> = {};
      for (const [key, propertySchema] of Object.entries(properties)) {
        result[key] = generateInstance(propertySchema, preferences);
      }
      return result;
    }
    case 'array': {
      const minItems = typeof schema['minItems'] === 'number' ? schema['minItems'] : 1;
      const maxItems = typeof schema['maxItems'] === 'number' ? schema['maxItems'] : Math.max(minItems, 1);
      const count = Math.min(Math.max(minItems, 1), maxItems);
      return Array.from({ length: count }, () => generateInstance(schema['items'], preferences));
    }
    case 'string': {
      const minLength = typeof schema['minLength'] === 'number' ? schema['minLength'] : 0;
      return 'value'.padEnd(minLength, 'x');
    }
    case 'integer':
      return numberIn(schema, true);
    case 'number':
      return numberIn(schema, false);
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return {};
  }
};

export const collectAllowedNames = (schema: unknown): string[] => {
  const names: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    const properties = node['properties'];
    if (isRecord(properties) && properties['name'] !== undefined) {
      for (const value of allowedValues(properties['name'])) {
        if (typeof value === 'string') names.push(value);
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(schema);
  return names;
};

const containsNestedObject = (schema: JsonSchema): boolean => {
  const properties = schema['properties'];
  if (!isRecord(properties)) return false;
  return Object.values(properties).some((child) => isRecord(child) && isRecord(child['properties']));
};

export const findUsedKeywords = (schema: unknown, keywords: readonly string[]): string[] => {
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    for (const keyword of keywords) {
      if (keyword === 'nested') {
        if (containsNestedObject(node)) found.add(keyword);
      } else if (keyword in node) {
        found.add(keyword);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && isRecord(value)) Object.values(value).forEach(visit);
      else if (key !== 'const' && key !== 'enum') visit(value);
    }
  };
  visit(schema);
  return [...found];
};
