import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packagesDir = path.resolve(import.meta.dirname, '..', '..');

const sourcesOf = (packageName: string): Array<{ file: string; text: string }> => {
  const dir = path.join(packagesDir, packageName, 'src');
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ file: `${packageName}/src/${name}`, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
};

const definitionsOf = (pattern: RegExp): string[] =>
  [...sourcesOf('config'), ...sourcesOf('policy')].filter(({ text }) => pattern.test(text)).map(({ file }) => file);

describe('one definition per shell and rule lexeme (DUP-8)', () => {
  it('defines ASSIGNMENT only in policy/src/shell-lexemes.ts', () => {
    expect(definitionsOf(/\bconst ASSIGNMENT\s*=/)).toEqual(['policy/src/shell-lexemes.ts']);
  });

  it('does not re-export ASSIGNMENT from shell.ts', () => {
    const shell = fs.readFileSync(path.join(packagesDir, 'policy', 'src', 'shell.ts'), 'utf8');
    expect(shell).not.toMatch(/export[^;]*\bASSIGNMENT\b/);
  });

  it('defines the prefix suffix only as COMMAND_PREFIX_SUFFIX in config/src/rule.ts', () => {
    expect(definitionsOf(/\bconst \w*PREFIX_SUFFIX\s*=/)).toEqual(['config/src/rule.ts']);
    expect(definitionsOf(/\bconst COMMAND_PREFIX_SUFFIX\s*=/)).toEqual(['config/src/rule.ts']);
  });

  it('defines hasBalancedParentheses only in config/src/rule.ts', () => {
    expect(definitionsOf(/\bconst hasBalancedParentheses\s*=/)).toEqual(['config/src/rule.ts']);
  });
});

describe('side tables of section 3.11 are deleted (SEC-19)', () => {
  const NAMES: Readonly<Record<string, readonly string[]>> = {
    'command-match.ts': [
      'PACKAGE_MANAGER_DANGEROUS_OPTIONS',
      'PACKAGE_MANAGER_EXECUTING_SUBCOMMANDS',
      'FIND_EXECUTING_PRIMARIES',
      'ALWAYS_EXECUTING_PROGRAMS',
      'GIT_GLOBAL_DANGEROUS_LONG',
      'GIT_SAFE_VALUED_GLOBALS',
      'GIT_DANGEROUS_SUBCOMMANDS',
      'GIT_DANGEROUS_LONG',
      'GIT_UPLOAD_PACK_SHORT_SUBCOMMANDS',
      'isGitDangerous',
      'invokesDangerousOption',
      'isExecutingPackageInvocation',
      'firstOperand',
      'optionName',
    ],
    'path-effects.ts': [
      'COPY_VALUED',
      'SED_VALUED',
      'CURL_VALUED_LETTERS',
      'TAR_VALUED',
      'TRANSFER_VALUED',
      'GIT_CLONE_VALUED',
      'GIT_GLOBAL_VALUED',
      'READER_VALUED',
      'SEARCH_VALUED',
      'INTERPRETER_INLINE',
      'INTERPRETER_NAMES',
      'positionalArguments',
      'shortValues',
      'longValues',
      'hasLiteral',
      'effectsFor',
    ],
    'shell.ts': ['DIRECTORY_CHANGERS', 'SHELLS', 'NEVER_PREFIX_MATCHED'],
    'wrappers.ts': ['WRAPPER_SPECS', 'parseOption', 'parseLongOption', 'parseShortCluster'],
  };

  it.each(Object.entries(NAMES))('%s contains none of the deleted names', (file, names) => {
    const text = fs.readFileSync(path.join(packagesDir, 'policy', 'src', file), 'utf8');
    expect(names.filter((name) => new RegExp(`\\b${name}\\b`).test(text))).toEqual([]);
  });
});

describe('Stage D single definitions (V7, V15, V20)', () => {
  const read = (...parts: string[]): string => fs.readFileSync(path.join(packagesDir, ...parts), 'utf8');

  it.each([
    ['policy', 'approval.ts', /\bisOptionText\b/],
    ['policy', 'path-effects.ts', /\bisDarwinSed\b/],
    ['policy', 'path-effects.ts', /\boptionTarget\b/],
    ['config', 'load-settings.ts', /new Set\(\['Edit', 'Write'\]\)/],
    ['tools', 'executor.ts', /\bapprovalGatedWritePaths\b/],
  ])('%s/src/%s has no %s', (pkg, file, pattern) => {
    expect(read(pkg, 'src', file)).not.toMatch(pattern);
  });

  it('defines DARWIN_SED and globDirectory once', () => {
    expect(definitionsOf(/\bconst DARWIN_SED\s*=/)).toHaveLength(1);
    expect(read('policy', 'src', 'approval.ts')).not.toMatch(/lastIndexOf\('\/', pattern\.search/);
  });

  it('imports ./shell.ts once in decide.ts', () => {
    expect(read('policy', 'src', 'decide.ts').match(/^import \{[^}]*\} from '\.\/shell\.ts';$/gm)).toHaveLength(1);
  });

  it('keeps tool-policy.ts free of the re-export and of split foundation imports', () => {
    const text = read('runtime', 'src', 'process', 'tool-policy.ts');
    expect(text).not.toMatch(/export \{ createPolicyFilesystem/);
    expect(text.match(/^import \{[^}]*\} from '@momonga\/foundation';$/gm)).toHaveLength(1);
  });
});
