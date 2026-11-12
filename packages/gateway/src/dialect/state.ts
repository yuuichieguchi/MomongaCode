import type { DialectRule, SchemaNarrowing, WrapRecord } from '@momonga/protocol';
import { isNarrowing } from './candidates.ts';
import { SchemaRenderError } from './failure.ts';
import type { RenderFailureReason } from './failure.ts';
import type { RefIndex } from './references.ts';
import { feedsRestrictedProperties, unevaluatedFeeders } from './in-place-chain.ts';
import { isRecord, pointerSegments, unevaluatedPropertiesActive } from './schema.ts';
import type { JsonObject, Position } from './schema.ts';

export type RenderSite = { kind: 'tool-parameters'; tool: string } | { kind: 'response-format' } | { kind: 'probe' };

export type NodeContext = {
  readonly origin: string;
  readonly labelPath: string;
  readonly steps: readonly string[];
  readonly position: Position;
  readonly isRoot: boolean;
  readonly absent: boolean;
  readonly via: string | undefined;
  readonly location: string;
  readonly inPlace: readonly string[];
};

export type RenderState = {
  readonly site: RenderSite;
  readonly rules: readonly DialectRule[];
  document: unknown;
  refs: RefIndex;
  refSegments: ReadonlySet<string>;
  readonly originOverride: WeakMap<object, string>;
  readonly synthetic: WeakSet<object>;
  readonly wrappers: WeakSet<object>;
  readonly narrowings: Map<string, SchemaNarrowing>;
  readonly wraps: WrapRecord[];
  readonly writtenProperties: WeakSet<object>;
};

export class FreeFormObject extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`the object at ${path === '' ? 'the root' : path} accepts properties it does not name, which a closed schema cannot express`);
    this.name = 'FreeFormObject';
    this.path = path;
  }
}

export const toolOf = (state: RenderState): string | undefined => (state.site.kind === 'tool-parameters' ? state.site.tool : undefined);

export const fail = (state: RenderState, reason: RenderFailureReason, path: string, detail: string): never => {
  throw new SchemaRenderError(reason, toolOf(state), path, detail);
};

export const requirePositive = (state: RenderState, context: NodeContext, op: string): void => {
  if (context.position !== 'positive') fail(state, 'polarity', context.origin, `${op} would change a node at a ${context.position} position`);
};

export const guardWrittenKeys = (state: RenderState, keys: readonly string[], op: string): void => {
  const clash = keys.find((key) => state.refSegments.has(key));
  if (clash !== undefined) fail(state, 'written-key', '', `${op} writes "${clash}", which a $ref pointer passes through`);
};

export const reportNarrowing = (state: RenderState, context: NodeContext, rule: DialectRule): void => {
  if (!isNarrowing(rule)) throw new Error(`the dialect operation ${rule.op} is not in the list of narrowing operations, so it cannot record a narrowing`);
  const tool = toolOf(state);
  if (tool === undefined || context.absent) return;
  if (!state.narrowings.has(context.origin)) state.narrowings.set(context.origin, { tool, path: context.origin });
};

export const writeAt = (state: RenderState, location: string, value: unknown): void => {
  if (location === '') {
    state.document = value;
    return;
  }
  const segments = pointerSegments(location);
  const last = segments[segments.length - 1] as string;
  let holder: unknown = state.document;
  for (const segment of segments.slice(0, -1)) holder = Array.isArray(holder) ? holder[Number(segment)] : isRecord(holder) ? holder[segment] : undefined;
  if (Array.isArray(holder)) holder[Number(last)] = value;
  else if (isRecord(holder)) holder[last] = value;
};

export const feedersOf = (state: RenderState, context: NodeContext): JsonObject[] =>
  unevaluatedFeeders(state.document, { location: context.location, inPlace: context.inPlace, hasReferences: state.refs.positions.size > 0 });

export const hasActiveUneval = (state: RenderState, context: NodeContext, node: JsonObject): boolean =>
  unevaluatedPropertiesActive(node) || feedsRestrictedProperties(feedersOf(state, context));
