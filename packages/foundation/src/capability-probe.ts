export type CapabilityResult<T> =
  | { kind: 'supported'; value: T; evidence: string }
  | { kind: 'unsupported'; evidence: string }
  | { kind: 'unmeasured'; evidence: string };

export const unmeasuredBecause = (error: unknown): { kind: 'unmeasured'; evidence: string } => ({
  kind: 'unmeasured',
  evidence: error instanceof Error ? error.message : String(error),
});

export const createCapabilityProbe = <Input, Value>(
  keyOf: (input: Input) => string,
  measure: (input: Input) => CapabilityResult<Value>,
): ((input: Input) => CapabilityResult<Value>) => {
  const cache = new Map<string, CapabilityResult<Value>>();
  return (input) => {
    const key = keyOf(input);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let result: CapabilityResult<Value>;
    try {
      result = measure(input);
    } catch (error) {
      return unmeasuredBecause(error);
    }
    if (result.kind !== 'unmeasured') cache.set(key, result);
    return result;
  };
};

export const createAsyncCapabilityProbe = <Input, Value>(
  keyOf: (input: Input) => string,
  measure: (input: Input) => Promise<CapabilityResult<Value>>,
): ((input: Input) => Promise<CapabilityResult<Value>>) => {
  const cache = new Map<string, CapabilityResult<Value>>();
  return async (input) => {
    const key = keyOf(input);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let result: CapabilityResult<Value>;
    try {
      result = await measure(input);
    } catch (error) {
      return unmeasuredBecause(error);
    }
    if (result.kind !== 'unmeasured') cache.set(key, result);
    return result;
  };
};
