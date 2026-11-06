import { VOCABULARY_KEYWORDS, type Rule } from './definition.ts';
import { clone, deepEqual, isObject, jsonTypeOf, matchesType, parsePointer, resolvePointer, type Json, type JsonObject, type Schema } from './json.ts';
import type { Site } from './selector.ts';
import { childSlots, SAME_LOCATION_EDGES, setSlot, slotValue } from './walk.ts';

export type FailureReason =
  | 'unsatisfiable'
  | 'loop'
  | 'reject'
  | 'polarity'
  | 'dependency'
  | 'ref-sibling'
  | 'written-key'
  | 'unresolved-ref';

export const STATED_REASONS: readonly FailureReason[] = ['loop', 'reject', 'polarity', 'dependency', 'written-key', 'unsatisfiable', 'ref-sibling'];

export class RenderFailure extends Error {
  readonly reason: FailureReason;
  readonly path: string;
  readonly node: Schema;
  constructor(reason: FailureReason, path: string, detail: string, node?: Schema) {
    super(`${reason} at ${path}: ${detail}`);
    this.reason = reason;
    this.path = path;
    this.node = node;
  }
}

export interface Ancestor {
  node: JsonObject;
  edge: string;
  pointerLength: number;
}

export interface State {
  site: Site;
  edges: string[];
  pointer: string[];
  position: Position;
  ancestors: Ancestor[];
  holder: { value: Schema };
  pendingDrops: { node: JsonObject; keys: string[] }[];
}

export type Position = 'P' | 'N' | 'M';

const pathOf = (state: State): string => `/${state.pointer.join('/')}`;

const OBJECT_VOCABULARY = [
  'properties', 'patternProperties', 'additionalProperties', 'required', 'propertyNames', 'minProperties', 'maxProperties',
  'dependentRequired', 'dependentSchemas', 'unevaluatedProperties',
];
const ARRAY_VOCABULARY = [
  'items', 'prefixItems', 'contains', 'minItems', 'maxItems', 'uniqueItems', 'minContains', 'maxContains', 'unevaluatedItems',
  'additionalItems',
];
const STRING_VOCABULARY = ['minLength', 'maxLength', 'pattern', 'format', 'contentEncoding', 'contentMediaType', 'contentSchema'];
const NUMERIC_VOCABULARY = ['multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum'];
const ALL_VOCABULARIES: ReadonlySet<string> = new Set([...OBJECT_VOCABULARY, ...ARRAY_VOCABULARY, ...STRING_VOCABULARY, ...NUMERIC_VOCABULARY]);
const KNOWN_KEYWORDS: ReadonlySet<string> = new Set(VOCABULARY_KEYWORDS);
const NAMED_ANNOTATIONS: ReadonlySet<string> = new Set(['title', 'description', 'default', 'deprecated', 'readOnly', 'writeOnly', 'examples', '$comment']);

const vocabularyOf = (type: string): readonly string[] => {
  if (type === 'object') return OBJECT_VOCABULARY;
  if (type === 'array') return ARRAY_VOCABULARY;
  if (type === 'string') return STRING_VOCABULARY;
  if (type === 'number' || type === 'integer') return NUMERIC_VOCABULARY;
  return [];
};

const isAnnotationKey = (key: string): boolean => NAMED_ANNOTATIONS.has(key) || !KNOWN_KEYWORDS.has(key);

const typesOf = (node: JsonObject): string[] | undefined => {
  const type = node['type'];
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((entry): entry is string => typeof entry === 'string');
  return undefined;
};

const copyWithout = (node: JsonObject, keys: readonly string[]): JsonObject => {
  const result: JsonObject = {};
  for (const key of Object.keys(node)) if (!keys.includes(key)) result[key] = node[key] as Json;
  return result;
};

const unevaluatedIsRestrictive = (value: Schema): boolean => isObject(value) && 'unevaluatedProperties' in value && value['unevaluatedProperties'] !== true;

interface RefSite {
  target: string[];
  chain: { node: JsonObject; location: string[] }[];
}

const scanReferenceSites = (document: Schema): RefSite[] => {
  const sites: RefSite[] = [];
  const visit = (node: Json, pointer: string[], stack: { node: JsonObject; edge: string; pointerLength: number }[]): void => {
    if (!isObject(node)) return;
    const reference = node['$ref'];
    if (typeof reference === 'string') {
      const target = parsePointer(reference);
      if (target !== undefined) {
        const chain: RefSite['chain'] = [{ node, location: pointer }];
        for (let index = stack.length - 1; index >= 0; index -= 1) {
          const entry = stack[index] as (typeof stack)[number];
          if (!SAME_LOCATION_EDGES.includes(entry.edge)) break;
          chain.push({ node: entry.node, location: pointer.slice(0, entry.pointerLength) });
        }
        sites.push({ target, chain });
      }
    }
    for (const slot of childSlots(node)) {
      visit(slotValue(slot), [...pointer, ...slot.segments], [...stack, { node, edge: slot.edge, pointerLength: pointer.length }]);
    }
  };
  if (document !== undefined) visit(document, [], []);
  return sites;
};

const inPlaceChain = (state: State): JsonObject[] => {
  const nodes: JsonObject[] = [];
  const locations: string[][] = [state.pointer];
  for (let index = state.ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = state.ancestors[index] as Ancestor;
    if (!SAME_LOCATION_EDGES.includes(ancestor.edge)) break;
    nodes.push(ancestor.node);
    locations.push(state.pointer.slice(0, ancestor.pointerLength));
  }
  const known = new Set(locations.map((location) => JSON.stringify(location)));
  const sites = scanReferenceSites(state.holder.value);
  let grew = true;
  while (grew) {
    grew = false;
    for (const site of sites) {
      if (!known.has(JSON.stringify(site.target))) continue;
      for (const entry of site.chain) {
        if (!nodes.includes(entry.node)) nodes.push(entry.node);
        const key = JSON.stringify(entry.location);
        if (!known.has(key)) {
          known.add(key);
          grew = true;
        }
      }
    }
  }
  return nodes;
};

const unevaluatedConflict = (node: JsonObject, state: State): boolean =>
  unevaluatedIsRestrictive(node) || inPlaceChain(state).some((entry) => unevaluatedIsRestrictive(entry));

const IN_PLACE = ['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', 'dependentSchemas', '$ref'];

const DEPENDENTS: Record<string, string[]> = {
  properties: ['additionalProperties', 'unevaluatedProperties'],
  patternProperties: ['additionalProperties', 'unevaluatedProperties'],
  additionalProperties: ['unevaluatedProperties'],
  prefixItems: ['items', 'unevaluatedItems'],
  items: ['additionalItems', 'unevaluatedItems'],
  contains: ['minContains', 'maxContains', 'unevaluatedItems'],
  if: ['then', 'else', 'unevaluatedProperties', 'unevaluatedItems'],
  allOf: ['unevaluatedProperties', 'unevaluatedItems'],
  anyOf: ['unevaluatedProperties', 'unevaluatedItems'],
  oneOf: ['unevaluatedProperties', 'unevaluatedItems'],
  then: ['unevaluatedProperties', 'unevaluatedItems'],
  else: ['unevaluatedProperties', 'unevaluatedItems'],
  dependentSchemas: ['unevaluatedProperties', 'unevaluatedItems'],
  $ref: ['unevaluatedProperties', 'unevaluatedItems'],
};

const DEPENDS_ON: Record<string, string[]> = {
  additionalProperties: ['properties', 'patternProperties'],
  items: ['prefixItems'],
  additionalItems: ['items'],
  minContains: ['contains'],
  maxContains: ['contains'],
  then: ['if'],
  else: ['if'],
  unevaluatedProperties: ['properties', 'patternProperties', 'additionalProperties', ...IN_PLACE],
  unevaluatedItems: ['prefixItems', 'items', 'contains', ...IN_PLACE],
};

const FEEDS_PROPERTIES = ['properties', 'patternProperties', 'additionalProperties', 'unevaluatedProperties', ...IN_PLACE];
const FEEDS_ITEMS = ['prefixItems', 'items', 'contains', 'unevaluatedItems', ...IN_PLACE];

export const dropClosure = (node: JsonObject, keys: readonly string[]): string[] => {
  const closure = new Set<string>();
  const requested = keys.filter((key) => Object.hasOwn(node, key));
  const queue = requested.includes('minContains') && node['minContains'] === 0 && Object.hasOwn(node, 'contains') ? [...requested, 'contains'] : requested;
  while (queue.length > 0) {
    const key = queue.pop() as string;
    if (closure.has(key)) continue;
    closure.add(key);
    for (const dependent of DEPENDENTS[key] ?? []) if (Object.hasOwn(node, dependent)) queue.push(dependent);
  }
  return [...closure];
};

export const allowedDropKeys = (keys: readonly string[]): Set<string> => {
  const allowed = new Set<string>();
  const queue = keys.includes('minContains') ? [...keys, 'contains'] : [...keys];
  while (queue.length > 0) {
    const key = queue.pop() as string;
    if (allowed.has(key)) continue;
    allowed.add(key);
    queue.push(...(DEPENDENTS[key] ?? []));
  }
  return allowed;
};

const dropWithClosure = (node: JsonObject, keys: readonly string[], state: State): JsonObject => {
  const closure = dropClosure(node, keys);
  if (closure.length === 0) return node;
  const feeds: string[] = [];
  if (closure.some((key) => FEEDS_PROPERTIES.includes(key))) feeds.push('unevaluatedProperties');
  if (closure.some((key) => FEEDS_ITEMS.includes(key))) feeds.push('unevaluatedItems');
  if (feeds.length > 0) {
    for (const entry of inPlaceChain(state)) {
      const present = feeds.filter((key) => Object.hasOwn(entry, key));
      if (present.length > 0) state.pendingDrops.push({ node: entry, keys: present });
    }
  }
  return copyWithout(node, closure);
};

const dependencySets = (keys: ReadonlySet<string>, dependent: string): string => (DEPENDS_ON[dependent] ?? []).filter((key) => keys.has(key)).sort().join(',');

const valuesType = (values: readonly Json[]): string | undefined => {
  if (values.length === 0) return undefined;
  const kinds = new Set(values.map(jsonTypeOf));
  if (kinds.size === 2 && kinds.has('integer') && kinds.has('number')) return 'number';
  if (kinds.size === 1) return [...kinds][0];
  return undefined;
};

const commonBranchType = (branches: Json): string | undefined => {
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  const types = branches.map((branch) => (isObject(branch) && typeof branch['type'] === 'string' ? branch['type'] : undefined));
  const first = types[0];
  return first !== undefined && types.every((type) => type === first) ? first : undefined;
};

const fillType = (node: JsonObject, fallback: string): JsonObject => {
  if (Object.hasOwn(node, 'type')) return node;
  let type: string | undefined;
  if ('const' in node) type = valuesType([node['const'] as Json]);
  if (type === undefined && Array.isArray(node['enum'])) type = valuesType(node['enum']);
  if (type === undefined) type = commonBranchType(node['oneOf'] as Json) ?? commonBranchType(node['allOf'] as Json);
  if (type === undefined && isObject(node['properties'])) type = 'object';
  if (type === undefined && 'items' in node) type = 'array';
  return { ...node, type: type ?? fallback };
};

const parentAnnotations = (node: JsonObject): JsonObject => {
  const result: JsonObject = {};
  for (const key of Object.keys(node)) if (isAnnotationKey(key) && !ALL_VOCABULARIES.has(key)) result[key] = clone(node[key] as Json);
  return result;
};

const branchFor = (node: JsonObject, type: string): JsonObject => {
  const vocabulary = vocabularyOf(type);
  const branch: JsonObject = { type };
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'enum') continue;
    if (!ALL_VOCABULARIES.has(key) || vocabulary.includes(key)) branch[key] = clone(node[key] as Json);
  }
  return branch;
};

const splitEnum = (node: JsonObject, state: State): JsonObject => {
  if (!Array.isArray(node['enum'])) return node;
  const allowed = typesOf(node);
  const values = allowed === undefined ? node['enum'] : node['enum'].filter((value) => allowed.some((type) => matchesType(value, type)));
  if (values.length === 0) throw new RenderFailure('unsatisfiable', pathOf(state), 'no enum value has an allowed type', node);
  const groups = new Map<string, Json[]>();
  for (const value of values) {
    const raw = jsonTypeOf(value);
    const key = raw === 'integer' ? 'number' : raw;
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  if (groups.size <= 1) return { ...node, enum: values };
  const branches: Json[] = [];
  for (const [key, members] of groups) {
    const type = key === 'number' && members.every((member) => Number.isInteger(member)) ? 'integer' : key;
    const branch = branchFor(node, type);
    branch['enum'] = clone(members);
    branches.push(branch);
  }
  return { ...parentAnnotations(node), anyOf: branches };
};

const splitTypeArray = (node: JsonObject, state: State): JsonObject => {
  if (!Array.isArray(node['type'])) return node;
  const branches: Json[] = [];
  for (const type of node['type']) {
    if (typeof type !== 'string') continue;
    const branch = branchFor(node, type);
    if ('const' in node && !matchesType(node['const'] as Json, type)) continue;
    if (Array.isArray(node['enum'])) {
      const values = node['enum'].filter((value) => matchesType(value, type));
      if (values.length === 0) continue;
      branch['enum'] = clone(values);
    }
    branches.push(branch);
  }
  if (branches.length === 0) throw new RenderFailure('unsatisfiable', pathOf(state), 'no branch keeps a value', node);
  return { ...parentAnnotations(node), anyOf: branches };
};

const constAsEnum = (node: JsonObject, state: State): JsonObject => {
  if (!('const' in node)) return node;
  const value = node['const'] as Json;
  if (Array.isArray(node['enum']) && !node['enum'].some((member) => deepEqual(member, value))) {
    throw new RenderFailure('unsatisfiable', pathOf(state), 'const is outside enum', node);
  }
  const result: JsonObject = {};
  for (const key of Object.keys(node)) {
    if (key === 'const') continue;
    result[key] = key === 'enum' ? [clone(value)] : (node[key] as Json);
  }
  if (!('enum' in result)) result['enum'] = [clone(value)];
  return result;
};

const ensureKey = (node: JsonObject, rule: Extract<Rule, { op: 'ensure-key' }>, state: State): JsonObject => {
  const present = Object.hasOwn(node, rule.key);
  const overwrite = rule.overwrite ?? 'never';
  let write = !present;
  if (present && rule.key === 'additionalProperties' && rule.value === false) {
    const current = node[rule.key];
    if (overwrite === 'non-boolean') write = typeof current !== 'boolean';
    if (overwrite === 'always') write = current !== false;
  }
  if (!write) return node;
  if (rule.key === 'additionalProperties' && rule.value === true && unevaluatedConflict(node, state)) {
    throw new RenderFailure('dependency', pathOf(state), 'additionalProperties true would mark properties evaluated');
  }
  return { ...node, [rule.key]: clone(rule.value) };
};

const declareRequired = (node: JsonObject, state: State): JsonObject => {
  if (!Array.isArray(node['required'])) return node;
  const properties: JsonObject = isObject(node['properties']) ? { ...node['properties'] } : {};
  const patterns = isObject(node['patternProperties']) ? Object.keys(node['patternProperties']) : [];
  let added = false;
  for (const name of node['required']) {
    if (typeof name !== 'string' || Object.hasOwn(properties, name)) continue;
    if (patterns.some((pattern) => new RegExp(pattern, 'u').test(name))) {
      properties[name] = {};
    } else {
      const open = node['additionalProperties'];
      properties[name] = open === undefined || open === true ? {} : clone(open);
    }
    added = true;
  }
  if (!added) return node;
  if (unevaluatedConflict(node, state)) {
    throw new RenderFailure('dependency', pathOf(state), 'a declared property would become evaluated');
  }
  return { ...node, properties };
};

const ASSERTION_KEYS: ReadonlySet<string> = new Set([
  'type', 'enum', 'const', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'maxLength', 'minLength',
  'pattern', 'maxItems', 'minItems', 'uniqueItems', 'maxContains', 'minContains', 'maxProperties', 'minProperties', 'required',
  'dependentRequired', 'format', 'contentEncoding', 'contentMediaType',
]);

const mergeReference = (target: Json, siblings: JsonObject, state: State): Json => {
  const keys = Object.keys(siblings);
  if (keys.length === 0) return target;
  for (const key of keys) {
    if (!isAnnotationKey(key) && !ASSERTION_KEYS.has(key)) {
      throw new RenderFailure('ref-sibling', pathOf(state), `sibling ${key} is neither an annotation nor an assertion`);
    }
  }
  if (target === true) return siblings;
  if (target === false) return false;
  if (!isObject(target)) throw new RenderFailure('ref-sibling', pathOf(state), 'target is not a schema');
  const shared = keys.filter((key) => Object.hasOwn(target, key));
  if (shared.length > 0) throw new RenderFailure('ref-sibling', pathOf(state), `sibling shares ${shared.join(',')} with the target`);
  const targetKeys = new Set(Object.keys(target));
  const siblingKeys = new Set([...keys, '$ref']);
  const mergedKeys = new Set([...targetKeys, ...keys]);
  for (const dependent of Object.keys(DEPENDS_ON)) {
    const origin = keys.includes(dependent) ? siblingKeys : targetKeys;
    if ((keys.includes(dependent) || targetKeys.has(dependent)) && dependencySets(origin, dependent) !== dependencySets(mergedKeys, dependent)) {
      throw new RenderFailure('dependency', pathOf(state), `${dependent} would see a different dependency set after the merge`);
    }
  }
  return { ...target, ...siblings };
};

const inlineNode = (node: Json, document: Schema, stack: readonly string[], state: State): Json => {
  if (!isObject(node)) return node;
  const reference = node['$ref'];
  if (typeof reference === 'string') {
    const segments = parsePointer(reference);
    if (segments === undefined) throw new RenderFailure('unresolved-ref', pathOf(state), `${reference} is not a same-document pointer`);
    if (stack.includes(reference)) throw new RenderFailure('loop', pathOf(state), `${reference} loops`);
    const target = resolvePointer(document, segments);
    if (target === undefined) throw new RenderFailure('unresolved-ref', pathOf(state), `${reference} does not resolve`);
    const inlined = inlineNode(clone(target), document, [...stack, reference], state);
    return mergeReference(inlined, copyWithout(node, ['$ref', '$defs', 'definitions']), state);
  }
  const result = copyWithout(node, ['$defs', 'definitions']);
  for (const slot of childSlots(result)) setSlot(slot, inlineNode(slotValue(slot), document, stack, state));
  return result;
};

const inlineRefs = (node: Schema, state: State): Schema => {
  if (!isObject(node)) return node;
  return inlineNode(node, state.holder.value, [], state);
};

export const applyRule = (rule: Rule, node: Schema, state: State): Schema => {
  if (rule.op === 'empty-parameters') {
    return node === undefined ? { type: 'object', properties: {} } : node;
  }
  if (rule.op === 'inline-refs') return inlineRefs(node, state);
  if (!isObject(node)) return node;
  switch (rule.op) {
    case 'reject': {
      const found = rule.keys.filter((key) => Object.hasOwn(node, key));
      if (found.length > 0) throw new RenderFailure('reject', pathOf(state), `carries ${found.join(',')}`);
      return node;
    }
    case 'drop':
      return dropWithClosure(node, rule.keys, state);
    case 'fill-type':
      return fillType(node, rule.fallback);
    case 'split-enum':
      return splitEnum(node, state);
    case 'split-type-array':
      return splitTypeArray(node, state);
    case 'const-as-enum':
      return constAsEnum(node, state);
    case 'ensure-key':
      return ensureKey(node, rule, state);
    case 'label': {
      if (Object.hasOwn(node, rule.key)) return node;
      const label = ['root', ...state.pointer.filter((segment) => segment !== 'properties')].join('_');
      return { ...node, [rule.key]: label };
    }
    case 'property-order':
      return isObject(node['properties']) ? { ...node, [rule.key]: Object.keys(node['properties']) } : node;
    case 'require-all': {
      if (!isObject(node['properties'])) return node;
      const existing = Array.isArray(node['required']) ? node['required'] : [];
      const added = Object.keys(node['properties']).filter((name) => !existing.includes(name));
      return added.length === 0 ? node : { ...node, required: [...existing, ...added] };
    }
    case 'declare-required':
      return declareRequired(node, state);
    default:
      return node;
  }
};
