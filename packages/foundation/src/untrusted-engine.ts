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

const OPTIONS = { engine: 'interpreter', useDefaults: false, assertFormat: false, coerceTypes: false, removeAdditional: false } as const;

export const ataEngine: Engine = {
  compile: (schema, registry) => {
    const validator = new Validator(schema, { ...OPTIONS, schemas: { ...registry } });
    validator.engine();
    return (instance) => {
      const result = validator.validate(instance);
      return result.valid ? { valid: true } : { valid: false, errors: result.errors };
    };
  },
};
