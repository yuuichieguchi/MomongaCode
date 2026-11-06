import { feedersOf, guardWrittenKeys, requirePositive } from './state.ts';
import type { NodeContext, RenderState } from './state.ts';
import type { JsonObject } from './schema.ts';

const IN_PLACE_APPLICATORS = ['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', 'dependentSchemas', 'dependencies', '$ref', '$dynamicRef'] as const;

const DEPENDENTS: Readonly<Record<string, readonly string[]>> = {
  properties: ['additionalProperties', 'unevaluatedProperties'],
  patternProperties: ['additionalProperties', 'unevaluatedProperties'],
  additionalProperties: ['unevaluatedProperties'],
  prefixItems: ['items', 'additionalItems', 'unevaluatedItems'],
  items: ['additionalItems', 'unevaluatedItems'],
  contains: ['minContains', 'maxContains', 'unevaluatedItems'],
  if: ['then', 'else', 'unevaluatedProperties', 'unevaluatedItems'],
  ...Object.fromEntries(IN_PLACE_APPLICATORS.filter((keyword) => keyword !== 'if').map((keyword) => [keyword, ['unevaluatedProperties', 'unevaluatedItems']])),
};

const PROPERTY_EVALUATORS: ReadonlySet<string> = new Set(['properties', 'patternProperties', 'additionalProperties', 'unevaluatedProperties', ...IN_PLACE_APPLICATORS]);

const ITEM_EVALUATORS: ReadonlySet<string> = new Set(['prefixItems', 'items', 'additionalItems', 'contains', 'unevaluatedItems', ...IN_PLACE_APPLICATORS]);

const closureOf = (start: readonly string[]): Set<string> => {
  const closed = new Set(start);
  for (const key of closed) for (const dependent of DEPENDENTS[key] ?? []) closed.add(dependent);
  return closed;
};

export const dropKeys = (state: RenderState, node: JsonObject, keys: readonly string[], context: NodeContext): JsonObject => {
  const requested = keys.filter((key) => key in node);
  if (requested.length === 0) return node;
  const start = requested.includes('minContains') && node['minContains'] === 0 && 'contains' in node ? [...requested, 'contains'] : requested;
  const removed = [...closureOf(start)].filter((key) => key in node);
  requirePositive(state, context, 'drop');
  guardWrittenKeys(state, removed, 'drop');
  const touchesProperties = removed.some((key) => PROPERTY_EVALUATORS.has(key));
  const touchesItems = removed.some((key) => ITEM_EVALUATORS.has(key));
  const feeders = touchesProperties || touchesItems ? feedersOf(state, context) : [];
  const fed = [...(touchesProperties ? ['unevaluatedProperties'] : []), ...(touchesItems ? ['unevaluatedItems'] : [])];
  guardWrittenKeys(state, fed.filter((key) => feeders.some((feeder) => key in feeder)), 'drop');
  for (const feeder of feeders) for (const key of fed) delete feeder[key];
  return Object.fromEntries(Object.entries(node).filter(([key]) => !removed.includes(key)));
};
