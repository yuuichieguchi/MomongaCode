export const cachedCountOf = (value: unknown, fieldName: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} is present but is not a non-negative integer: ${JSON.stringify(value)}`);
  }
  return value;
};
