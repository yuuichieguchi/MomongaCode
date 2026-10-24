export type FlagKind = 'string' | 'int' | 'boolean';

export type FlagSpec = Readonly<Record<string, { kind: FlagKind; required?: boolean }>>;

type FlagValue<K extends FlagKind> = K extends 'int' ? number : K extends 'boolean' ? boolean : string;

export type ParsedFlags<S extends FlagSpec> = {
  readonly [N in keyof S]: S[N]['kind'] extends 'boolean'
    ? boolean
    : S[N]['required'] extends true
      ? FlagValue<S[N]['kind']>
      : FlagValue<S[N]['kind']> | undefined;
};

export class EntryUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntryUsageError';
  }
}

export const BASE_ENTRY_FLAGS = {
  'app-version': { kind: 'string', required: true },
  home: { kind: 'string' },
  'log-target': { kind: 'string' },
} as const satisfies FlagSpec;

export const COMMON_ENTRY_FLAGS = {
  ...BASE_ENTRY_FLAGS,
  'lifeline-fd': { kind: 'int' },
} as const satisfies FlagSpec;

const INTEGER_PATTERN = /^-?\d+$/;

export const parseFlags = <S extends FlagSpec>(argv: readonly string[], spec: S): ParsedFlags<S> => {
  const values = new Map<string, string | number | boolean>();
  for (const argument of argv) {
    if (!argument.startsWith('--')) throw new EntryUsageError(`unexpected argument ${argument}`);
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
    const raw = separator === -1 ? undefined : argument.slice(separator + 1);
    if (!Object.hasOwn(spec, name)) throw new EntryUsageError(`unknown flag --${name}`);
    if (values.has(name)) throw new EntryUsageError(`duplicate flag --${name}`);
    const kind = (spec[name] as { kind: FlagKind }).kind;
    if (kind === 'boolean') {
      if (raw !== undefined) throw new EntryUsageError(`flag --${name} takes no value`);
      values.set(name, true);
      continue;
    }
    if (raw === undefined) throw new EntryUsageError(`flag --${name} requires a value`);
    if (kind === 'int') {
      if (!INTEGER_PATTERN.test(raw)) throw new EntryUsageError(`flag --${name} requires an integer, got ${raw}`);
      values.set(name, Number.parseInt(raw, 10));
      continue;
    }
    values.set(name, raw);
  }
  const parsed: Record<string, string | number | boolean | undefined> = {};
  for (const [name, definition] of Object.entries(spec)) {
    if (definition.required === true && !values.has(name)) throw new EntryUsageError(`missing required flag --${name}`);
    parsed[name] = values.get(name) ?? (definition.kind === 'boolean' ? false : undefined);
  }
  return parsed as ParsedFlags<S>;
};
