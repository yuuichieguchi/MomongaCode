import { applyRule } from './primitives.ts';
import { IN_PLACE_KEYWORDS, VALUE_POSITION_KEYWORDS, assignChild, childPointer, childrenOf, composePosition, isRecord, joinPosition, stepPosition } from './schema.ts';
import type { ChildEntry, JsonObject } from './schema.ts';
import { clauseMatches } from './select.ts';
import { writeAt } from './state.ts';
import type { NodeContext, RenderState } from './state.ts';

const labelStep = (child: ChildEntry): string => {
  if (child.keyword === 'properties') return child.key ?? child.keyword;
  return child.key === undefined ? child.keyword : `${child.keyword}_${child.key}`;
};

const childContext = (state: RenderState, parent: NodeContext, parentNode: JsonObject, child: ChildEntry): NodeContext => {
  const location = childPointer(parent.location, child.keyword, child.key);
  if (state.wrappers.has(parentNode) && child.keyword === 'anyOf') return { ...parent, isRoot: false, absent: false, location };
  const keepsOrigin = state.synthetic.has(parentNode) && child.keyword === 'anyOf';
  const origin = keepsOrigin ? parent.origin : childPointer(parent.origin, child.keyword, child.key);
  const referenced = state.refs.positions.get(origin);
  let position;
  if (child.keyword === '$defs' || child.keyword === 'definitions') {
    position = referenced ?? 'positive';
  } else {
    const structural = composePosition(parent.position, stepPosition(child.keyword, parentNode));
    position = referenced === undefined ? structural : joinPosition(structural, referenced);
  }
  const inPlace = IN_PLACE_KEYWORDS.has(child.keyword);
  return {
    origin,
    labelPath: `${parent.labelPath}_${labelStep(child)}`,
    steps: [...parent.steps, child.keyword],
    position,
    isRoot: false,
    absent: false,
    via: child.keyword,
    location,
    inPlace: inPlace ? [...parent.inPlace, parent.location] : [],
  };
};

export const visit = (state: RenderState, value: unknown, context: NodeContext, asNode: boolean): unknown => {
  if (value === false || (value === true && !asNode)) return value;
  if (value !== true && !isRecord(value)) return value;
  const override = isRecord(value) ? state.originOverride.get(value) : undefined;
  const here = override === undefined ? context : { ...context, origin: override };
  let current: unknown = value;
  for (const rule of state.rules) {
    const node: JsonObject = isRecord(current) ? current : {};
    if (!rule.select.some((clause) => clauseMatches(clause, node, here, state))) continue;
    const result = applyRule(state, rule, node, here);
    if (isRecord(current) || result !== node || Object.keys(result).length > 0) {
      if (current !== result) writeAt(state, context.location, result);
      current = result;
    }
  }
  if (isRecord(current)) {
    for (const child of childrenOf(current)) {
      const next = visit(state, child.value, childContext(state, here, current, child), VALUE_POSITION_KEYWORDS.has(child.keyword));
      if (next !== child.value) assignChild(current, child, next);
    }
  }
  return current;
};
