export type Scope = Readonly<Record<string, unknown>>;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

const REFERENCE = /\{((?:input|before|after|call)(?:\.[A-Za-z0-9_]+)+)\}/g;

export const lookup = (scope: Scope, reference: string): string | undefined => {
  let current: unknown = scope;
  for (const segment of reference.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current) || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === 'string') return current;
  if (typeof current === 'number' || typeof current === 'boolean') return String(current);
  if (isStringList(current)) return current.join(' ');
  return undefined;
};

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

export const lookupList = (scope: Scope, reference: string): string[] | undefined => {
  let current: unknown = scope;
  for (const segment of reference.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current) || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return isStringList(current) ? current : undefined;
};

export const renderTemplate = (template: string, scope: Scope): string =>
  template.replace(REFERENCE, (_match, reference: string) => {
    const value = lookup(scope, reference);
    if (value === undefined) throw new TemplateError(`${reference} has no value`);
    return value;
  });

export const isTruthy = (scope: Scope, reference: string): boolean => {
  const value = lookup(scope, reference);
  return value === 'true';
};

export const REFERENCE_PATTERN = '^(input|before|after|call)(\\.[A-Za-z0-9_]+)+$';
