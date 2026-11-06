export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Schema = Json | undefined;

export const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

export const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

export const deepEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject);
  if (leftKeys.length !== Object.keys(rightObject).length) return false;
  return leftKeys.every((key) => Object.hasOwn(rightObject, key) && deepEqual(leftObject[key], rightObject[key]));
};

export const canonical = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
};

export const exact = (value: unknown): string => (value === undefined ? 'undefined' : JSON.stringify(value));

export const parsePointer = (reference: string): string[] | undefined => {
  if (reference === '#') return [];
  if (!reference.startsWith('#/')) return undefined;
  return reference
    .slice(2)
    .split('/')
    .map((segment) => decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~'));
};

export const resolvePointer = (document: Json | undefined, segments: readonly string[]): Json | undefined => {
  let current: Json | undefined = document;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isObject(current)) {
      current = Object.hasOwn(current, segment) ? current[segment] : undefined;
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
};

export const jsonTypeOf = (value: Json): 'null' | 'boolean' | 'string' | 'number' | 'integer' | 'array' | 'object' => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value as 'boolean' | 'string' | 'object';
};

export const matchesType = (value: Json, type: string): boolean => {
  const actual = jsonTypeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
};
