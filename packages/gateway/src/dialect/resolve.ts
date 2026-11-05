import { BUILTIN_DIALECTS } from '@momonga/protocol';
import type { BuiltinDialectId, DialectDefinition, DialectId } from '@momonga/protocol';
import { DIALECT_DEFINITION_SCHEMA } from '@momonga/protocol';
import { defineProductSchema, productErrorsText } from '@momonga/foundation';

export class DialectDefinitionError extends Error {
  constructor(id: DialectId, reason: string) {
    super(`schema dialect "${id}": ${reason}`);
    this.name = 'DialectDefinitionError';
  }
}

const validateDefinition = defineProductSchema<DialectDefinition>('gateway/dialect-definition', DIALECT_DEFINITION_SCHEMA);

const isBuiltinId = (id: DialectId): id is BuiltinDialectId => Object.hasOwn(BUILTIN_DIALECTS, id);

export const definitionOf = (id: DialectId, userDialects: Readonly<Record<DialectId, DialectDefinition>>): DialectDefinition => {
  const declared = Object.hasOwn(userDialects, id) ? userDialects[id] : undefined;
  if (isBuiltinId(id)) {
    if (declared !== undefined) throw new DialectDefinitionError(id, 'a built-in id cannot be declared again');
    return BUILTIN_DIALECTS[id];
  }
  if (declared === undefined) throw new DialectDefinitionError(id, 'it is neither a built-in dialect nor declared in models.dialects');
  const verdict = validateDefinition(declared);
  if (!verdict.valid) throw new DialectDefinitionError(id, `the definition is invalid: ${productErrorsText(verdict.errors, 'definition')}`);
  const base = declared.extends;
  if (base === undefined) return { rules: [...declared.rules] };
  if (!isBuiltinId(base)) throw new DialectDefinitionError(id, `extends "${base}", which is not a built-in dialect`);
  return { rules: [...BUILTIN_DIALECTS[base].rules, ...declared.rules] };
};
