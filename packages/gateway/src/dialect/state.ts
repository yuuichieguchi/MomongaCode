import type { DialectRule, SchemaNarrowing, WrapRecord } from '@momonga/protocol';
import { SchemaRenderError } from './failure.ts';
import type { RenderFailureReason } from './failure.ts';
import type { RefIndex } from './references.ts';
import { unevaluatedPropertiesActive } from './schema.ts';
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
  readonly inPlace: readonly JsonObject[];
  readonly refUneval: boolean;
};

export type RenderState = {
  readonly site: RenderSite;
  readonly rules: readonly DialectRule[];
  refs: RefIndex;
  refSegments: ReadonlySet<string>;
  readonly originOverride: WeakMap<object, string>;
  readonly synthetic: WeakSet<object>;
  readonly wrappers: WeakSet<object>;
  readonly narrowings: Map<string, SchemaNarrowing>;
  readonly wraps: WrapRecord[];
};

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

export const reportNarrowing = (state: RenderState, context: NodeContext): void => {
  const tool = toolOf(state);
  if (tool === undefined || context.absent) return;
  if (!state.narrowings.has(context.origin)) state.narrowings.set(context.origin, { tool, path: context.origin });
};

export const hasActiveUneval = (context: NodeContext, node: JsonObject): boolean =>
  context.refUneval || unevaluatedPropertiesActive(node) || context.inPlace.some(unevaluatedPropertiesActive);
