import { describe, expect, it } from 'vitest';
import { BASE_ENTRY_FLAGS, COMMON_ENTRY_FLAGS, EntryUsageError, parseFlags } from '@momonga/foundation';
import type { FlagSpec } from '@momonga/foundation';

const RUNTIME_LIKE = {
  ...COMMON_ENTRY_FLAGS,
  'lease-ms': { kind: 'int' },
  'sandbox-exec-path': { kind: 'string' },
  'fm-binary': { kind: 'string' },
  verbose: { kind: 'boolean' },
} as const satisfies FlagSpec;

const usageErrorOf = (argv: readonly string[], spec: FlagSpec = RUNTIME_LIKE): unknown => {
  try {
    parseFlags(argv, spec);
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('COMMON_ENTRY_FLAGS', () => {
  it('declares --app-version (required), --home, --lifeline-fd (int) and --log-target', () => {
    expect(COMMON_ENTRY_FLAGS).toEqual({
      'app-version': { kind: 'string', required: true },
      home: { kind: 'string' },
      'lifeline-fd': { kind: 'int' },
      'log-target': { kind: 'string' },
    });
  });
});

describe('parseFlags', () => {
  it('parses each kind', () => {
    const flags = parseFlags(['--app-version=1.2.3', '--home=/Users/alice', '--lease-ms=3000', '--verbose'], RUNTIME_LIKE);
    expect(flags['app-version']).toBe('1.2.3');
    expect(flags.home).toBe('/Users/alice');
    expect(flags['lease-ms']).toBe(3000);
    expect(flags.verbose).toBe(true);
    expect(flags['lifeline-fd']).toBeUndefined();
    expect(flags['log-target']).toBeUndefined();
  });

  it('--lifeline-fd=3 yields 3', () => {
    expect(parseFlags(['--app-version=1', '--lifeline-fd=3'], COMMON_ENTRY_FLAGS)['lifeline-fd']).toBe(3);
  });

  it('keeps a value containing = whole', () => {
    expect(parseFlags(['--app-version=1', '--fm-binary=/a=b'], RUNTIME_LIKE)['fm-binary']).toBe('/a=b');
  });

  it.each([
    ['a non-integer int', ['--app-version=1', '--lease-ms=abc'], 'lease-ms'],
    ['a fractional int', ['--app-version=1', '--lease-ms=1.5'], 'lease-ms'],
    ['an int without a value', ['--app-version=1', '--lease-ms'], 'lease-ms'],
    ['an unknown flag', ['--app-version=1', '--colour=red'], 'colour'],
    ['a duplicate flag', ['--app-version=1', '--home=/a', '--home=/b'], 'home'],
    ['a missing required flag', ['--home=/a'], 'app-version'],
    ['a string flag without a value', ['--app-version=1', '--home'], 'home'],
    ['a positional argument', ['--app-version=1', 'serve'], 'serve'],
  ])('throws EntryUsageError for %s, naming it', (_name, argv, named) => {
    const error = usageErrorOf(argv);
    expect(error).toBeInstanceOf(EntryUsageError);
    expect((error as Error).message).toContain(named);
  });

  it('EntryUsageError is an Error', () => {
    expect(new EntryUsageError('x')).toBeInstanceOf(Error);
  });
});

describe('BASE_ENTRY_FLAGS', () => {
  it('BASE_ENTRY_FLAGS declares exactly app-version (required), home and log-target', () => {
    expect(BASE_ENTRY_FLAGS).toEqual({
      'app-version': { kind: 'string', required: true },
      home: { kind: 'string' },
      'log-target': { kind: 'string' },
    });
    expect(Object.keys(BASE_ENTRY_FLAGS).sort()).toEqual(['app-version', 'home', 'log-target']);
  });

  it('COMMON_ENTRY_FLAGS contains every BASE_ENTRY_FLAGS entry by identity', () => {
    const baseKeys = Object.keys(BASE_ENTRY_FLAGS) as Array<keyof typeof BASE_ENTRY_FLAGS>;
    expect(baseKeys.sort()).toEqual(['app-version', 'home', 'log-target']);
    for (const key of baseKeys) expect(COMMON_ENTRY_FLAGS[key], key).toBe(BASE_ENTRY_FLAGS[key]);
    expect(Object.keys(COMMON_ENTRY_FLAGS).sort()).toEqual([...baseKeys, 'lifeline-fd'].sort());
  });

  it('parseFlags with BASE_ENTRY_FLAGS accepts the base flags', () => {
    expect(parseFlags(['--app-version=2.0.0', '--home=/h', '--log-target=file'], BASE_ENTRY_FLAGS)).toEqual({
      'app-version': '2.0.0',
      home: '/h',
      'log-target': 'file',
    });
  });

  it('parseFlags with BASE_ENTRY_FLAGS rejects --lifeline-fd', () => {
    const error = usageErrorOf(['--app-version=2.0.0', '--lifeline-fd=3'], BASE_ENTRY_FLAGS);
    expect(error).toBeInstanceOf(EntryUsageError);
    expect((error as Error).message).toBe('unknown flag --lifeline-fd');
  });

  it('parseFlags with BASE_ENTRY_FLAGS requires --app-version', () => {
    const error = usageErrorOf(['--home=/h'], BASE_ENTRY_FLAGS);
    expect(error).toBeInstanceOf(EntryUsageError);
    expect((error as Error).message).toBe('missing required flag --app-version');
  });
});
