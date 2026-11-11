export const PATH_PATTERN = '^$|^[A-Za-z_][A-Za-z0-9_]*(\\[[0-9]+\\])*(\\.[A-Za-z_][A-Za-z0-9_]*(\\[[0-9]+\\])*)*$';

const SEGMENT = /([A-Za-z_][A-Za-z0-9_]*)|\[([0-9]+)\]/g;

export const valueAt = (document: unknown, path: string): unknown => {
  if (path === '') return document;
  let current: unknown = document;
  for (const match of path.matchAll(SEGMENT)) {
    const [, key, index] = match;
    if (key !== undefined) {
      if (typeof current !== 'object' || current === null || Array.isArray(current) || !Object.hasOwn(current, key)) return undefined;
      current = (current as Record<string, unknown>)[key];
    } else {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(index)];
    }
  }
  return current;
};

export const textAt = (document: unknown, path: string): string | undefined => {
  const value = valueAt(document, path);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
};
