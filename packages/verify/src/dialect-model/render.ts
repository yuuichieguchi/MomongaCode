import { classOf, resolveRules, type Definition, type Rule } from './definition.ts';
import { clone, deepEqual, isObject, parsePointer, type Json, type JsonObject, type Schema } from './json.ts';
import { applyRule, RenderFailure, type FailureReason, type Position, type State } from './primitives.ts';
import { selects, type Site } from './selector.ts';
import { childSlots, collectReferenceSegments, labelStep, NODE_EDGES, setSlot, slotValue } from './walk.ts';

export type Rendered = { ok: true; schema: Schema } | { ok: false; reason: FailureReason; path: string; detail: string; node: Schema };

const changedKeys = (before: Schema, after: Schema): string[] => {
  const left = isObject(before) ? before : {};
  const right = isObject(after) ? after : {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => !deepEqual(left[key], right[key]));
};

const compose = (parent: Position, edge: string, node: JsonObject): Position => {
  if (parent === 'M') return 'M';
  if (edge === 'oneOf' || edge === 'if') return 'M';
  if (edge === 'contains' && Object.hasOwn(node, 'maxContains')) return 'M';
  if (edge === 'not') return parent === 'P' ? 'N' : 'P';
  return parent;
};

const join = (current: Position | undefined, next: Position): Position => (current === undefined || current === next ? next : 'M');

const definitionPositions = (document: Schema): Map<string, Position> => {
  const positions = new Map<string, Position>();
  for (let round = 0; round < 8; round += 1) {
    let changed = false;
    const walk = (node: Json, pointer: string[], position: Position): void => {
      if (!isObject(node)) return;
      const reference = node['$ref'];
      if (typeof reference === 'string') {
        const target = parsePointer(reference);
        if (target !== undefined) {
          const index = target.findIndex((segment, at) => (segment === '$defs' || segment === 'definitions') && at + 1 < target.length);
          if (index !== -1) {
            const key = JSON.stringify(target.slice(0, index + 2));
            const next = join(positions.get(key), position);
            if (positions.get(key) !== next) {
              positions.set(key, next);
              changed = true;
            }
          }
        }
      }
      for (const slot of childSlots(node)) {
        const path = [...pointer, ...slot.segments];
        const childPosition = slot.edge === '$defs' || slot.edge === 'definitions' ? (positions.get(JSON.stringify(path)) ?? 'P') : compose(position, slot.edge, node);
        walk(slotValue(slot), path, childPosition);
      }
    };
    if (document !== undefined) walk(document, [], 'P');
    if (!changed) break;
  }
  return positions;
};

const applyAt = (rules: readonly Rule[], initial: Schema, state: State, write: (value: Schema) => void): Schema => {
  const trueIsNode = initial === true && (state.edges.length === 0 || NODE_EDGES.includes(state.edges[state.edges.length - 1] as string));
  let node: Schema = trueIsNode ? {} : initial;
  for (const rule of rules) {
    if (!selects(rule.select, node, { site: state.site, edges: state.edges })) continue;
    const before = node;
    state.pendingDrops = [];
    const after = applyRule(rule, before, state);
    if (deepEqual(before, after)) continue;
    const ruleClass = classOf(rule);
    if (state.position !== 'P' && (ruleClass === 'N' || ruleClass === 'W')) {
      throw new RenderFailure('polarity', `/${state.pointer.join('/')}`, `${rule.op} would change a node in a negative position`);
    }
    if (rule.op !== 'inline-refs') {
      const written = [...changedKeys(before, after), ...state.pendingDrops.flatMap((entry) => entry.keys)];
      if (written.length > 0) {
        const segments = collectReferenceSegments(state.holder.value);
        const hit = written.find((key) => segments.has(key));
        if (hit !== undefined) {
          throw new RenderFailure('written-key', `/${state.pointer.join('/')}`, `${rule.op} writes ${hit}, which a $ref pointer passes through`);
        }
      }
    }
    node = after;
    write(node);
    for (const entry of state.pendingDrops) for (const key of entry.keys) delete entry.node[key];
  }
  return trueIsNode && isObject(node) && Object.keys(node).length === 0 ? true : node;
};

const visit = (rules: readonly Rule[], read: () => Schema, write: (value: Schema) => void, state: State): void => {
  const node = applyAt(rules, read(), state, write);
  write(node);
  if (!isObject(node)) return;
  for (const slot of childSlots(node)) {
    if (slotValue(slot) === undefined) continue;
    const child: State = {
      site: state.site,
      edges: [...state.edges, slot.edge],
      pointer: [...state.pointer, ...slot.segments],
      label: [...state.label, labelStep(slot)],
      position:
        slot.edge === '$defs' || slot.edge === 'definitions'
          ? (definitionPositions(state.holder.value).get(JSON.stringify([...state.pointer, ...slot.segments])) ?? 'P')
          : compose(state.position, slot.edge, node),
      pendingDrops: [],
      ancestors: [...state.ancestors, { node, edge: slot.edge, pointerLength: state.pointer.length }],
      holder: state.holder,
    };
    visit(rules, () => slotValue(slot) as Schema, (value) => setSlot(slot, value as Json), child);
  }
};

export const render = (input: Schema | null, definition: Definition, site: Site): Rendered => {
  const rules = resolveRules(definition);
  const holder: { value: Schema } = { value: input === null ? undefined : clone(input) };
  const state: State = { site, edges: [], pointer: [], label: [], position: 'P', pendingDrops: [], ancestors: [], holder };
  try {
    visit(rules, () => holder.value, (value) => {
      holder.value = value;
    }, state);
  } catch (error) {
    if (error instanceof RenderFailure) return { ok: false, reason: error.reason, path: error.path, detail: error.message, node: error.node };
    throw error;
  }
  return { ok: true, schema: holder.value };
};

export type { JsonObject };
