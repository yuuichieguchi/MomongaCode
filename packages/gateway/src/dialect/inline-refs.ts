import { EMPTY_REFS, refTarget } from './references.ts';
import { APPLICATOR_KEYS, escapePointerSegment, isRecord, mapChildren, resolvePointer } from './schema.ts';
import type { JsonObject } from './schema.ts';
import { fail } from './state.ts';
import type { NodeContext, RenderState } from './state.ts';

const REMOVED_KEYS = new Set(['$defs', 'definitions']);

const pointerOf = (origin: string, keyword: string, key: string | undefined): string =>
  `${origin}/${keyword}${key === undefined ? '' : `/${escapePointerSegment(key)}`}`;

const merge = (state: RenderState, site: JsonObject, target: unknown, origin: string): unknown => {
  const siblings = Object.entries(site).filter(([key]) => key !== '$ref' && !REMOVED_KEYS.has(key));
  if (target === false) return false;
  const base = isRecord(target) ? target : {};
  if (siblings.length === 0) return target;
  for (const [key] of siblings) {
    if (APPLICATOR_KEYS.has(key)) fail(state, 'ref-sibling', origin, `the $ref has the applicator ${key} beside it`);
    if (key in base) fail(state, 'ref-sibling', origin, `the $ref and its target both carry ${key}`);
    if ((key === 'minContains' || key === 'maxContains') && 'contains' in base) {
      fail(state, 'dependency', origin, `${key} beside the $ref would see the contains of its target`);
    }
  }
  return { ...base, ...Object.fromEntries(siblings.map(([key, value]): [string, unknown] => [key, structuredClone(value)])) };
};

export const inlineRefs = (state: RenderState, root: JsonObject, _context: NodeContext): JsonObject => {
  const inlineNode = (value: unknown, origin: string, stack: readonly string[]): unknown => {
    if (!isRecord(value)) return value;
    const ref = value['$ref'];
    if (typeof ref === 'string') {
      const pointer = refTarget(ref);
      if (pointer === undefined) return fail(state, 'construct', origin, `the reference ${ref} does not point into this document`);
      if (stack.includes(pointer)) return fail(state, 'loop', origin, `the reference ${ref} leads back to itself`);
      const target = resolvePointer(root, pointer);
      if (target === undefined) return fail(state, 'construct', origin, `the reference ${ref} resolves to nothing`);
      const inlined = inlineNode(structuredClone(target), pointer, [...stack, pointer]);
      const merged = merge(state, value, inlined, origin);
      if (isRecord(merged) && !state.originOverride.has(merged)) state.originOverride.set(merged, pointer);
      return merged;
    }
    const rebuilt = mapChildren(value, (child) => (REMOVED_KEYS.has(child.keyword) ? child.value : inlineNode(child.value, pointerOf(origin, child.keyword, child.key), stack)));
    for (const key of REMOVED_KEYS) delete rebuilt[key];
    return rebuilt;
  };
  const result = inlineNode(root, '', []);
  state.refs = EMPTY_REFS;
  state.refSegments = new Set();
  return isRecord(result) ? result : root;
};
