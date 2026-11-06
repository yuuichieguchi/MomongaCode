import type { AdapterRequest, Capabilities, JsonReplyPath, TextFormat } from '@momonga/protocol';
import { renderSchema } from '../../dialect/render.ts';
import type { ResolvedDialect } from '../../dialect/render.ts';

type JsonSchemaFormat = Extract<TextFormat, { type: 'json_schema' }>;

export type JsonReplyPlan = { path: 'enforced'; format: JsonSchemaFormat } | { path: 'prompt' };

export type JsonReplyFormat = { name: string; description?: string; strict?: boolean | null; schema: unknown };

export const jsonReplyPlanOf = (request: AdapterRequest, capabilities: Pick<Capabilities, 'structuredOutput'>): JsonReplyPlan | undefined => {
  const format = request.text?.format;
  if (format === undefined || format === null || format.type !== 'json_schema') return undefined;
  return capabilities.structuredOutput === 'json_schema' ? { path: 'enforced', format } : { path: 'prompt' };
};

export const jsonReplyPathOf = (plan: JsonReplyPlan | undefined): JsonReplyPath | undefined => plan?.path;

export const jsonReplyFormatOf = (plan: JsonReplyPlan | undefined, dialect: ResolvedDialect): JsonReplyFormat | undefined => {
  if (plan?.path !== 'enforced') return undefined;
  const { name, description, strict, schema } = plan.format;
  return {
    name,
    ...(description === undefined ? {} : { description }),
    ...(strict === undefined ? {} : { strict }),
    schema: renderSchema(schema, { kind: 'response-format' }, dialect).schema,
  };
};
