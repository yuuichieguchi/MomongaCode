import type { ConstructSupport, DialectDefinition, DialectId, SchemaNarrowing, WrapRecord } from '@momonga/protocol';
import { scanConstructs } from './constructs.ts';
import { SchemaRenderError } from './failure.ts';
import { analyzeReferences } from './references.ts';
import { isRecord } from './schema.ts';
import type { NodeContext, RenderSite, RenderState } from './state.ts';
import { visit } from './traverse.ts';

export { SchemaRenderError };
export type { RenderSite };

export type ResolvedDialect = { id: DialectId; definition: DialectDefinition; constructSupport?: ConstructSupport };

const renderedBrand: unique symbol = Symbol('rendered-schema');

export type RenderedSchema = {
  readonly schema: unknown;
  readonly wraps: readonly WrapRecord[];
  readonly narrowings: readonly SchemaNarrowing[];
  readonly [renderedBrand]: true;
};

export const renderSchema = (schema: unknown, site: RenderSite, resolved: ResolvedDialect): RenderedSchema => {
  if (site.kind === 'tool-parameters' && resolved.constructSupport !== undefined) scanConstructs(schema, site.tool, resolved.constructSupport);
  const absent = schema === undefined || schema === null;
  const root: unknown = absent ? {} : structuredClone(schema);
  const { index, segments } = analyzeReferences(root);
  const state: RenderState = {
    site,
    document: root,
    rules: resolved.definition.rules,
    refs: index,
    refSegments: segments,
    originOverride: new WeakMap(),
    synthetic: new WeakSet(),
    wrappers: new WeakSet(),
    narrowings: new Map(),
    wraps: [],
  };
  const context: NodeContext = { origin: '', labelPath: 'root', steps: [], position: 'positive', isRoot: true, absent, via: undefined, location: '', inPlace: [] };
  const rendered = visit(state, root, context, true);
  const untouched = absent && isRecord(rendered) && Object.keys(rendered).length === 0;
  return {
    schema: untouched ? undefined : rendered,
    wraps: state.wraps,
    narrowings: [...state.narrowings.values()],
    [renderedBrand]: true,
  };
};
