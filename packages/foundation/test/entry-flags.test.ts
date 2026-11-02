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
  it('declares --home, --lifeline-fd (int) and --log-target, and no version flag', () => {
    expect(COMMON_ENTRY_FLAGS).toEqual({
      home: { kind: 'string' },
      'lifeline-fd': { kind: 'int' },
      'log-target': { kind: 'string' },
    });
  });
});

describe('parseFlags', () => {
  it('parses each kind', () => {
    const flags = parseFlags(['--home=/Users/alice', '--lease-ms=3000', '--verbose'], RUNTIME_LIKE);
    expect(flags.home).toBe('/Users/alice');
    expect(flags['lease-ms']).toBe(3000);
    expect(flags.verbose).toBe(true);
    expect(flags['lifeline-fd']).toBeUndefined();
    expect(flags['log-target']).toBeUndefined();
  });

  it('--lifeline-fd=3 yields 3', () => {
    expect(parseFlags(['--lifeline-fd=3'], COMMON_ENTRY_FLAGS)['lifeline-fd']).toBe(3);
  });

  it('keeps a value containing = whole', () => {
    expect(parseFlags(['--fm-binary=/a=b'], RUNTIME_LIKE)['fm-binary']).toBe('/a=b');
  });

  it.each([
    ['a non-integer int', ['--lease-ms=abc'], 'lease-ms'],
    ['a fractional int', ['--lease-ms=1.5'], 'lease-ms'],
    ['an int without a value', ['--lease-ms'], 'lease-ms'],
    ['an unknown flag', ['--colour=red'], 'colour'],
    ['a version flag a client could use to label the binary', ['--app-version=1'], 'app-version'],
    ['a duplicate flag', ['--home=/a', '--home=/b'], 'home'],
    ['a string flag without a value', ['--home'], 'home'],
    ['a positional argument', ['serve'], 'serve'],
  ])('throws EntryUsageError for %s, naming it', (_name, argv, named) => {
    const error = usageErrorOf(argv);
    expect(error).toBeInstanceOf(EntryUsageError);
    expect((error as Error).message).toContain(named);
  });

  it('throws EntryUsageError naming a missing required flag', () => {
    const error = usageErrorOf(['--home=/a'], { ...RUNTIME_LIKE, role: { kind: 'string', required: true } });
    expect(error).toBeInstanceOf(EntryUsageError);
    expect((error as Error).message).toBe('missing required flag --role');
  });

  it('EntryUsageError is an Error', () => {
    expect(new EntryUsageError('x')).toBeInstanceOf(Error);
  });
});

describe('BASE_ENTRY_FLAGS', () => {
  it('BASE_ENTRY_FLAGS declares exactly home and log-target', () => {
    expect(BASE_ENTRY_FLAGS).toEqual({
      home: { kind: 'string' },
      'log-target': { kind: 'string' },
    });
    expect(Object.keys(BASE_ENTRY_FLAGS).sort()).toEqual(['home', 'log-target']);
  });

  it('COMMON_ENTRY_FLAGS contains every BASE_ENTRY_FLAGS entry by identity', () => {
    const baseKeys = Object.keys(BASE_ENTRY_FLAGS) as Array<keyof typeof BASE_ENTRY_FLAGS>;
    expect(baseKeys.sort()).toEqual(['home', 'log-target']);
    for (const key of baseKeys) expect(COMMON_ENTRY_FLAGS[key], key).toBe(BASE_ENTRY_FLAGS[key]);
    expect(Object.keys(COMMON_ENTRY_FLAGS).sort()).toEqual([...baseKeys, 'lifeline-fd'].sort());
  });

  it('parseFlags with BASE_ENTRY_FLAGS accepts the base flags', () => {
    expect(parseFlags(['--home=/h', '--log-target=file'], BASE_ENTRY_FLAGS)).toEqual({
      home: '/h',
      'log-target': 'file',
    });
  });

  it('parseFlags with BASE_ENTRY_FLAGS rejects --lifeline-fd', () => {
    const error = usageErrorOf(['--lifeline-fd=3'], BASE_ENTRY_FLAGS);
    expect(error).toBeInstanceOf(EntryUsageError);
    expect((error as Error).message).toBe('unknown flag --lifeline-fd');
  });

  it('parseFlags with BASE_ENTRY_FLAGS rejects --app-version, because the version comes from the binary', () => {
    const error = usageErrorOf(['--app-version=2.0.0'], BASE_ENTRY_FLAGS);
    expect(error).toBeInstanceOf(EntryUsageError);
    expect((error as Error).message).toBe('unknown flag --app-version');
  });
});
