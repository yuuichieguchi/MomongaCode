import { inspect } from 'node:util';

export const asError = (value: unknown): Error => {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : inspect(value, { depth: 2 }), { cause: value });
};
