import { IN_PLACE_KEYWORDS, childrenOf, composePosition, escapePointerSegment, isRecord, joinPosition, pointerSegments, stepPosition, unevaluatedActive } from './schema.ts';
import type { Position } from './schema.ts';

export type RefIndex = { readonly positions: ReadonlyMap<string, Position>; readonly uneval: ReadonlySet<string> };

export const EMPTY_REFS: RefIndex = { positions: new Map(), uneval: new Set() };

export const refTarget = (ref: string): string | undefined => {
  if (!ref.startsWith('#')) return undefined;
  const pointer = ref.slice(1);
  return pointer === '' || pointer.startsWith('/') ? pointer : undefined;
};

const MAX_ROUNDS = 8;

type Pass = { positions: Map<string, Position>; uneval: Set<string>; segments: Set<string> };

const pass = (root: unknown, previous: RefIndex): Pass => {
  const next: Pass = { positions: new Map(), uneval: new Set(), segments: new Set() };
  const walk = (node: unknown, pointer: string, position: Position, evalAbove: boolean): void => {
    if (!isRecord(node)) return;
    const above = evalAbove || previous.uneval.has(pointer);
    const ref = node['$ref'];
    if (typeof ref === 'string') {
      const target = refTarget(ref);
      if (target !== undefined) {
        const prior = next.positions.get(target);
        next.positions.set(target, prior === undefined ? position : joinPosition(prior, position));
        if (above || unevaluatedActive(node)) next.uneval.add(target);
        for (const segment of pointerSegments(target)) next.segments.add(segment);
      }
    }
    for (const child of childrenOf(node)) {
      const childPointer = `${pointer}/${child.keyword}${child.key === undefined ? '' : `/${escapePointerSegment(child.key)}`}`;
      const referenced = previous.positions.get(childPointer);
      let childPosition: Position;
      if (child.keyword === '$defs' || child.keyword === 'definitions') {
        childPosition = referenced ?? 'positive';
      } else {
        const structural = composePosition(position, stepPosition(child.keyword, node));
        childPosition = referenced === undefined ? structural : joinPosition(structural, referenced);
      }
      walk(child.value, childPointer, childPosition, IN_PLACE_KEYWORDS.has(child.keyword) ? above || unevaluatedActive(node) : false);
    }
  };
  walk(root, '', 'positive', false);
  return next;
};

const samePositions = (left: ReadonlyMap<string, Position>, right: ReadonlyMap<string, Position>): boolean =>
  left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);

const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => left.size === right.size && [...left].every((entry) => right.has(entry));

export const analyzeReferences = (root: unknown): { index: RefIndex; segments: ReadonlySet<string> } => {
  let index: RefIndex = EMPTY_REFS;
  let current = pass(root, index);
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (samePositions(current.positions, index.positions) && sameSet(current.uneval, index.uneval)) return { index, segments: current.segments };
    index = { positions: current.positions, uneval: current.uneval };
    current = pass(root, index);
  }
  const widened = new Map([...current.positions.keys()].map((key): [string, Position] => [key, 'mixed']));
  return { index: { positions: widened, uneval: current.uneval }, segments: current.segments };
};
