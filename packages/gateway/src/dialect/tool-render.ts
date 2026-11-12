import type { RenderLedger } from './ledger.ts';
import { renderSchema } from './render.ts';
import type { RenderedSchema, ResolvedDialect } from './render.ts';

export type RenderableTool = { name: string; parameters?: unknown };

export const renderToolParameters = (tool: RenderableTool, dialect: ResolvedDialect, ledger?: RenderLedger): RenderedSchema => {
  const rendered = renderSchema(tool.parameters, { kind: 'tool-parameters', tool: tool.name }, dialect);
  ledger?.record(rendered, tool);
  return rendered;
};
