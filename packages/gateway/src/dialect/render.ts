import { strictPerToolOf } from '@momonga/protocol';
import type { ConstructSupport, DialectDefinition, DialectId, SchemaNarrowing, WrapRecord } from '@momonga/protocol';
import { scanConstructs } from './constructs.ts';
import { SchemaRenderError } from './failure.ts';
import { analyzeReferences } from './references.ts';
import { isRecord } from './schema.ts';
import { FreeFormObject } from './state.ts';
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
  readonly strict: boolean;
  readonly [renderedBrand]: true;
};

const nonStrictOf = (schema: unknown, site: RenderSite, resolved: ResolvedDialect, freeForm: FreeFormObject): RenderedSchema => {
  if (site.kind !== 'tool-parameters' || !strictPerToolOf(resolved.definition)) {
    throw new SchemaRenderError('free-form-object', site.kind === 'tool-parameters' ? site.tool : undefined, freeForm.path, `${freeForm.message}, and the dialect ${resolved.id} declares no per-tool strict flag`);
  }
  return { schema: structuredClone(schema), wraps: [], narrowings: [], strict: false, [renderedBrand]: true };
};

export const renderSchema = (schema: unknown, site: RenderSite, resolved: ResolvedDialect): RenderedSchema => {
  try {
    return renderedOf(schema, site, resolved);
  } catch (error) {
    if (error instanceof FreeFormObject) return nonStrictOf(schema, site, resolved, error);
    throw error;
  }
};

const renderedOf = (schema: unknown, site: RenderSite, resolved: ResolvedDialect): RenderedSchema => {
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
    writtenProperties: new WeakSet(),
  };
  const context: NodeContext = { origin: '', labelPath: 'root', steps: [], position: 'positive', isRoot: true, absent, via: undefined, location: '', inPlace: [] };
  const rendered = visit(state, root, context, true);
  const untouched = absent && isRecord(rendered) && Object.keys(rendered).length === 0;
  return {
    schema: untouched ? undefined : rendered,
    wraps: state.wraps,
    narrowings: [...state.narrowings.values()],
    strict: true,
    [renderedBrand]: true,
  };
};
