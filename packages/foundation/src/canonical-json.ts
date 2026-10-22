import { createHash } from 'node:crypto';

const fail = (kind: string, path: string): never => {
  throw new TypeError(`canonicalJson: cannot encode ${kind} at ${path === '' ? '<root>' : path}`);
};

const childKey = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

const encode = (value: unknown, path: string, ancestors: Set<object>): string => {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (Number.isNaN(value)) return fail('NaN (numbers must be finite)', path);
      if (!Number.isFinite(value)) return fail(`${value > 0 ? '' : '-'}Infinity (numbers must be finite)`, path);
      return JSON.stringify(value);
    case 'undefined':
      return fail('undefined', path);
    case 'function':
      return fail('function', path);
    case 'bigint':
      return fail('bigint', path);
    case 'symbol':
      return fail('symbol', path);
    default:
      break;
  }
  const object = value as object;
  if (ancestors.has(object)) return fail('circular reference', path);
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      const items = object.map((item: unknown, index) => encode(item, `${path}[${index}]`, ancestors));
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(object) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return fail(`non-plain object ${(object as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'}`, path);
    }
    const record = object as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(record[key], childKey(path, key), ancestors)}`);
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(object);
  }
};

export const canonicalJson = (value: unknown): string => encode(value, '', new Set());

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
