import type { ConstructResult, ConstructSupport } from '@momonga/protocol';
import { SchemaRenderError } from './failure.ts';
import { childrenOf, escapePointerSegment, isRecord, jsonTypeOf } from './schema.ts';

const blocked = (result: ConstructResult): boolean => result !== 'accepted';

const isMixedEnum = (values: readonly unknown[]): boolean => {
  const types = new Set(values.map(jsonTypeOf));
  if (types.has('integer') && types.has('number')) types.delete('integer');
  return types.size > 1;
};

export const scanConstructs = (schema: unknown, tool: string, support: ConstructSupport): void => {
  const visit = (node: unknown, origin: string): void => {
    if (!isRecord(node)) return;
    if ('$ref' in node && blocked(support.ref)) throw new SchemaRenderError('construct', tool, origin, `the target does not accept $ref (${support.ref})`);
    if (Array.isArray(node['type']) && blocked(support.typeArray)) throw new SchemaRenderError('construct', tool, origin, `the target does not accept a type array (${support.typeArray})`);
    if (Array.isArray(node['enum']) && isMixedEnum(node['enum']) && blocked(support.mixedEnum)) {
      throw new SchemaRenderError('construct', tool, origin, `the target does not accept an enum of mixed types (${support.mixedEnum})`);
    }
    for (const child of childrenOf(node)) visit(child.value, `${origin}/${child.keyword}${child.key === undefined ? '' : `/${escapePointerSegment(child.key)}`}`);
  };
  visit(schema, '');
};
