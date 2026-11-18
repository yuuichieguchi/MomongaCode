import { describe, expect, it } from 'vitest';
import { compileGlob } from '@momonga/foundation';
import { globTool } from '../../src/builtins/glob.ts';
import { makeBuiltins, resultOf } from './fixtures.ts';

describe('the glob language of the Glob tool', () => {
  it.each([
    ['+(a)+(a)+(a)', 'extglob groups such as +(...), *(...), ?(...), @(...) and !(...)'],
    ['**/*(a|b).ts', 'extglob groups such as +(...), *(...), ?(...), @(...) and !(...)'],
    ['((a)+)+b', 'parentheses and | alternation'],
    ['{a,b}+', 'a + quantifier after a brace set or a bracket class'],
    ['!src/**', 'a leading ! negation'],
  ])('refuses %s, naming the construct and the supported syntax', async (pattern, unsupported) => {
    expect(compileGlob(pattern)).toMatchObject({ kind: 'refused', unsupported });
    const tools = await makeBuiltins();
    tools.write('a.ts', 'x');
    const result = resultOf(await tools.run('Glob', { pattern }));
    expect(result).toMatchObject({
      status: 'failed',
      output: `The pattern ${pattern} uses ${unsupported}, which Glob does not support; use plain globs: *, **, ?, [...], {a,b}.`,
    });
  });

  it('finds files for ordinary patterns with braces, classes and dotfiles', async () => {
    const tools = await makeBuiltins();
    for (const file of ['src/a.ts', 'src/deep/b.tsx', 'src/d.ts', '.env']) tools.write(file, 'x');
    expect(resultOf(await tools.run('Glob', { pattern: 'src/**/[a-c]*.{ts,tsx}' })).output.split('\n').sort()).toEqual(['src/a.ts', 'src/deep/b.tsx']);
    expect(resultOf(await tools.run('Glob', { pattern: '.e*' })).output).toBe('.env');
  });

  it('states the supported syntax in its description', () => {
    expect(globTool.description).toContain('Supported syntax: *, **, ?, [...] and {a,b}; extglob groups, parentheses, | and a leading ! are refused.');
  });
});
