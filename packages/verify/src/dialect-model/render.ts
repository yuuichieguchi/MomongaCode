import { classOf, resolveRules, type Definition, type Rule } from './definition.ts';
import { clone, deepEqual, isObject, type Json, type JsonObject, type Schema } from './json.ts';
import { applyRule, RenderFailure, type FailureReason, type State } from './primitives.ts';
import { selects, type Site } from './selector.ts';
import { childSlots, collectReferenceSegments, setSlot, slotValue } from './walk.ts';

export type Rendered = { ok: true; schema: Schema } | { ok: false; reason: FailureReason; path: string; detail: string };

const changedKeys = (before: Schema, after: Schema): string[] => {
  const left = isObject(before) ? before : {};
  const right = isObject(after) ? after : {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => !deepEqual(left[key], right[key]));
};

const applyAt = (rules: readonly Rule[], initial: Schema, state: State, write: (value: Schema) => void): Schema => {
  let node = initial;
  for (const rule of rules) {
    if (!selects(rule.select, node, { site: state.site, edges: state.edges })) continue;
    const before = node;
    const after = applyRule(rule, before, state);
    if (deepEqual(before, after)) continue;
    const ruleClass = classOf(rule);
    if (!state.positive && (ruleClass === 'N' || ruleClass === 'W')) {
      throw new RenderFailure('polarity', `/${state.pointer.join('/')}`, `${rule.op} would change a node in a negative position`);
    }
    if (rule.op !== 'inline-refs') {
      const written = changedKeys(before, after);
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
  }
  return node;
};

const visit = (rules: readonly Rule[], read: () => Schema, write: (value: Schema) => void, state: State): void => {
  const node = applyAt(rules, read(), state, write);
  write(node);
  if (!isObject(node)) return;
  for (const slot of childSlots(node)) {
    const child: State = {
      site: state.site,
      edges: [...state.edges, slot.edge],
      pointer: [...state.pointer, ...slot.segments],
      positive: state.positive && slot.edge !== 'not' && slot.edge !== 'if',
      ancestors: [...state.ancestors, { node, edge: slot.edge, pointerLength: state.pointer.length }],
      holder: state.holder,
    };
    visit(rules, () => slotValue(slot) as Schema, (value) => setSlot(slot, value as Json), child);
  }
};

export const render = (input: Schema | null, definition: Definition, site: Site): Rendered => {
  const rules = resolveRules(definition);
  const holder: { value: Schema } = { value: input === null ? undefined : clone(input) };
  const state: State = { site, edges: [], pointer: [], positive: true, ancestors: [], holder };
  try {
    visit(rules, () => holder.value, (value) => {
      holder.value = value;
    }, state);
  } catch (error) {
    if (error instanceof RenderFailure) return { ok: false, reason: error.reason, path: error.path, detail: error.message };
    throw error;
  }
  return { ok: true, schema: holder.value };
};

export type { JsonObject };
