import { Validator } from '@momonga/ata-validator/lite';

export type RawError = {
  readonly keyword: string;
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly params: Record<string, unknown>;
  readonly message: string;
  readonly branchErrors?: readonly RawError[];
};

export type EngineVerdict = { valid: true } | { valid: false; errors: readonly RawError[] };

export type EngineValidator = (instance: unknown) => EngineVerdict;

export type Engine = {
  compile(schema: Record<string, unknown>, registry: Readonly<Record<string, object>>): EngineValidator;
};

const OPTIONS = { engine: 'interpreter', useDefaults: false, coerceTypes: false, removeAdditional: false } as const;

const FORMAT_ASSERTION_VOCABULARY = 'https://json-schema.org/draft/2020-12/vocab/format-assertion';

export const assertsFormat = (schema: Record<string, unknown>, registry: Readonly<Record<string, object>>): boolean => {
  const declared = schema['$schema'];
  if (typeof declared !== 'string') return false;
  const meta = registry[declared] as { $vocabulary?: unknown } | undefined;
  const vocabulary = meta?.$vocabulary;
  if (typeof vocabulary !== 'object' || vocabulary === null || Array.isArray(vocabulary)) return false;
  return typeof (vocabulary as Record<string, unknown>)[FORMAT_ASSERTION_VOCABULARY] === 'boolean';
};

export const ataEngine: Engine = {
  compile: (schema, registry) => {
    const validator = new Validator(schema, { ...OPTIONS, assertFormat: assertsFormat(schema, registry), schemas: { ...registry } });
    validator.engine();
    return (instance) => {
      const result = validator.validate(instance);
      return result.valid ? { valid: true } : { valid: false, errors: result.errors };
    };
  },
};
