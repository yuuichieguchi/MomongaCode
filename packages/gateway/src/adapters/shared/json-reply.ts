import { jsonReplyPathFor } from '@momonga/protocol';
import type { AdapterRequest, Capabilities, JsonReplyPath, TextFormat } from '@momonga/protocol';
import { renderSchema } from '../../dialect/render.ts';
import type { ResolvedDialect } from '../../dialect/render.ts';

type JsonSchemaFormat = Extract<TextFormat, { type: 'json_schema' }>;

type JsonObjectFormat = Extract<TextFormat, { type: 'json_object' }>;

export type JsonReplyPlan = { path: 'enforced'; format: JsonSchemaFormat | JsonObjectFormat } | { path: 'prompt' };

export type JsonReplyFormat = { name: string; description?: string; strict?: boolean | null; schema: unknown };

export const jsonReplyPlanOf = (request: AdapterRequest, capabilities: Pick<Capabilities, 'structuredOutput' | 'jsonMode'>): JsonReplyPlan | undefined => {
  const format = request.text?.format;
  const path = jsonReplyPathFor(format, capabilities);
  if (path === undefined || format === undefined || format === null || format.type === 'text') return undefined;
  return path === 'enforced' ? { path, format } : { path };
};

export const isJsonOnlyEnforced = (plan: JsonReplyPlan | undefined): boolean => plan?.path === 'enforced' && plan.format.type === 'json_object';

export const jsonReplyPathOf = (plan: JsonReplyPlan | undefined): JsonReplyPath | undefined => plan?.path;

export const jsonReplyFormatOf = (plan: JsonReplyPlan | undefined, dialect: ResolvedDialect): JsonReplyFormat | undefined => {
  if (plan?.path !== 'enforced' || plan.format.type !== 'json_schema') return undefined;
  const { name, description, strict, schema } = plan.format;
  return {
    name,
    ...(description === undefined ? {} : { description }),
    ...(strict === undefined ? {} : { strict }),
    schema: renderSchema(schema, { kind: 'response-format' }, dialect).schema,
  };
};
