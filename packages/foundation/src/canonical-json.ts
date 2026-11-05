import { createHash } from 'node:crypto';

const fail = (kind: string, path: string): never => {
  throw new TypeError(`canonicalJson: cannot encode ${kind} at ${path === '' ? '<root>' : path}`);
};

const childKey = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

type Frame = { readonly container: object; readonly keys: readonly string[] | undefined; readonly length: number; readonly path: string; next: number };

const scalarText = (value: unknown, path: string): string | undefined => {
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
      return undefined;
  }
};

export const canonicalJson = (value: unknown): string => {
  const out: string[] = [];
  const stack: Frame[] = [];
  const ancestors = new Set<object>();
  const visit = (current: unknown, path: string): void => {
    const text = scalarText(current, path);
    if (text !== undefined) {
      out.push(text);
      return;
    }
    const container = current as object;
    if (ancestors.has(container)) return fail('circular reference', path);
    ancestors.add(container);
    if (Array.isArray(container)) {
      out.push('[');
      stack.push({ container, keys: undefined, length: container.length, path, next: 0 });
      return;
    }
    const prototype = Object.getPrototypeOf(container) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return fail(`non-plain object ${(container as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'}`, path);
    }
    const keys = Object.keys(container).sort();
    out.push('{');
    stack.push({ container, keys, length: keys.length, path, next: 0 });
  };
  visit(value, '');
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    if (frame.next >= frame.length) {
      out.push(frame.keys === undefined ? ']' : '}');
      ancestors.delete(frame.container);
      stack.pop();
      continue;
    }
    if (frame.next > 0) out.push(',');
    const position = frame.next;
    frame.next += 1;
    if (frame.keys === undefined) {
      visit((frame.container as unknown[])[position], `${frame.path}[${position}]`);
    } else {
      const key = frame.keys[position] as string;
      out.push(`${JSON.stringify(key)}:`);
      visit((frame.container as Record<string, unknown>)[key], childKey(frame.path, key));
    }
  }
  return out.join('');
};

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
