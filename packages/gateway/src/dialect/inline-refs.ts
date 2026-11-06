import { analyzeReferences, refTarget } from './references.ts';
import { APPLICATOR_KEYS, DOCUMENT_KEYS, childPointer, isRecord, mapChildren, resolvePointer } from './schema.ts';
import type { JsonObject } from './schema.ts';
import { fail, writeAt } from './state.ts';
import type { NodeContext, RenderState } from './state.ts';

const REMOVED_KEYS = new Set(['$defs', 'definitions']);

const merge = (state: RenderState, site: JsonObject, target: unknown, origin: string): unknown => {
  const siblings = Object.entries(site).filter(([key]) => key !== '$ref' && !REMOVED_KEYS.has(key));
  if (target === false) return false;
  const base = isRecord(target) ? target : {};
  if (siblings.length === 0) return target;
  for (const [key] of siblings) {
    if (APPLICATOR_KEYS.has(key) || DOCUMENT_KEYS.has(key)) fail(state, 'ref-sibling', origin, `the $ref has ${key} beside it, which is neither an annotation nor an assertion`);
    if (key in base) fail(state, 'ref-sibling', origin, `the $ref and its target both carry ${key}`);
    if ((key === 'minContains' || key === 'maxContains') && 'contains' in base) {
      fail(state, 'dependency', origin, `${key} beside the $ref would see the contains of its target`);
    }
  }
  return { ...base, ...Object.fromEntries(siblings.map(([key, value]): [string, unknown] => [key, structuredClone(value)])) };
};

export const inlineRefs = (state: RenderState, selected: JsonObject, context: NodeContext): JsonObject => {
  const inlineNode = (value: unknown, origin: string, stack: readonly string[]): unknown => {
    if (!isRecord(value)) return value;
    const ref = value['$ref'];
    if (typeof ref === 'string') {
      const pointer = refTarget(ref);
      if (pointer === undefined) return fail(state, 'construct', origin, `the reference ${ref} does not point into this document`);
      if (stack.includes(pointer)) return fail(state, 'loop', origin, `the reference ${ref} leads back to itself`);
      const target = resolvePointer(state.document, pointer);
      if (target === undefined) return fail(state, 'construct', origin, `the reference ${ref} resolves to nothing`);
      const inlined = inlineNode(structuredClone(target), pointer, [...stack, pointer]);
      const merged = merge(state, value, inlined, origin);
      if (isRecord(merged) && !state.originOverride.has(merged)) state.originOverride.set(merged, pointer);
      return merged;
    }
    const rebuilt = mapChildren(value, (child) => (REMOVED_KEYS.has(child.keyword) ? child.value : inlineNode(child.value, childPointer(origin, child.keyword, child.key), stack)));
    for (const key of REMOVED_KEYS) delete rebuilt[key];
    return rebuilt;
  };
  const result = inlineNode(selected, context.origin, []);
  const inlined = isRecord(result) ? result : selected;
  writeAt(state, context.location, inlined);
  const { index, segments } = analyzeReferences(state.document);
  const dangling = [...index.positions.keys()].find((pointer) => resolvePointer(state.document, pointer) === undefined);
  if (dangling !== undefined) fail(state, 'construct', context.origin, `the reference to ${dangling} no longer resolves after the $defs inside the selected node were removed`);
  state.refs = index;
  state.refSegments = segments;
  return inlined;
};
