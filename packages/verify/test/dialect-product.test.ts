import { describe, expect, it } from 'vitest';
import { BUILTIN_DIALECTS } from '@momonga/protocol';
import type { DialectDefinition } from '@momonga/protocol';
import { SchemaRenderError, renderSchema } from '../../gateway/src/dialect/render.ts';
import { BUILTINS, resolveRules, type Definition } from '../src/dialect-model/definition.ts';
import type { CaseInput } from '../src/dialect-model/harness.ts';
import { resolvePointer, type Json } from '../src/dialect-model/json.ts';
import type { FailureReason } from '../src/dialect-model/primitives.ts';
import { runSubject, SUBJECTS } from '../src/dialect-model/subjects.ts';

const SCHEMAS_PER_SUBJECT = Number(process.env['DIALECT_PRODUCT_SCHEMAS'] ?? '300');
const TIMEOUT_MS = 60 * 60 * 1000;

const segmentsOf = (pointer: string): string[] => (pointer === '' ? [] : pointer.slice(1).split('/').map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~')));

export const productRenderer: NonNullable<CaseInput['renderer']> = (schema, definition, site) => {
  const resolved = { id: 'reference-model', definition: { rules: resolveRules(definition) } as unknown as DialectDefinition };
  try {
    const rendered = renderSchema(schema, site === 'tool-parameters' ? { kind: 'tool-parameters', tool: 'gen' } : { kind: 'response-format' }, resolved);
    return { ok: true, schema: rendered.schema as Json | undefined };
  } catch (error) {
    if (error instanceof SchemaRenderError) {
      const node = schema === null ? undefined : resolvePointer(schema, segmentsOf(error.path));
      return { ok: false, reason: error.reason as FailureReason, path: error.path === '' ? '/' : error.path, detail: error.message, node };
    }
    throw error;
  }
};

describe('dialect reference model against the product renderer', () => {
  it('the three built-in definitions the model carries are the product data', async () => {
    for (const id of ['json-schema-2020-12', 'explicit-keys', 'strict-closed'] as const) {
      const model: Definition | undefined = BUILTINS[id];
      expect(model, id).toBeDefined();
      const productRules = BUILTIN_DIALECTS[id].rules.filter((rule) => rule.op !== 'nullable-optional');
      expect(productRules, id).toEqual((model as Definition).rules);
    }
  });

  it.each(SUBJECTS.map((spec) => [spec.name, spec] as const))(
    '%s: the product render is sound under the model oracle',
    async (_name, spec) => {
      const report = await runSubject(spec, SCHEMAS_PER_SUBJECT, 20261106, () => undefined, productRenderer);
      expect({ schemas: report.stats.schemas, counterexamples: report.counterexamples, clusters: report.clusters, oracleErrors: report.stats.oracleErrors }).toEqual({
        schemas: SCHEMAS_PER_SUBJECT,
        counterexamples: 0,
        clusters: [],
        oracleErrors: 0,
      });
    },
    TIMEOUT_MS,
  );
});
