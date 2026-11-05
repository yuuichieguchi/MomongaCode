export const ENGINE_FAILURE_KEY = 'x-engine-throws';
export const ENGINE_FAILURE_MESSAGE = 'injected engine failure';

type InjectableEngine = { compile(schema: Record<string, unknown>, registry: Readonly<Record<string, object>>): (instance: unknown) => unknown };

export const injectEngineFailure = <Engine extends InjectableEngine>(engine: Engine): Engine => ({
  ...engine,
  compile: (schema, registry) => {
    const validate = engine.compile(schema, registry);
    if (schema[ENGINE_FAILURE_KEY] !== true) return validate;
    return () => {
      throw new RangeError(ENGINE_FAILURE_MESSAGE);
    };
  },
});

export const engineFailureSchema = (): Record<string, unknown> => ({ type: 'object', [ENGINE_FAILURE_KEY]: true });
