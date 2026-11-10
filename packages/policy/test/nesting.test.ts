import { describe, expect, it } from 'vitest';
import { MAX_NESTING, analyzeCommand } from '../src/shell.ts';
import { commandRow, kindIn } from './decision-rows.ts';

const nest = (depth: number): string => (depth === 0 ? 'echo x' : `echo $(${nest(depth - 1)})`);

describe('one scanner for comments and quoting', () => {
  it('reads the command behind a comment that contains a parenthesis inside a substitution', () => {
    const analysis = analyzeCommand("echo $(ls # ) '\ntouch pwn\n) # '");
    const inner = analysis?.nested[0];
    expect(inner?.segments.map((segment) => segment.text)).toEqual(['ls', 'touch pwn']);
  });

  it('reads the same command inside double quotes', () => {
    const analysis = analyzeCommand('echo "$(ls # ) \'\nrm -rf src\n) # \'"');
    expect(analysis?.nested[0]?.segments.map((segment) => segment.text)).toEqual(['ls', 'rm -rf src']);
  });

  it('rejects a substitution that is never closed', () => {
    expect(analyzeCommand('echo $(ls # )')).toBeNull();
  });
});

describe('MAX_NESTING (CON-9)', () => {
  it('is the policy value 8', () => {
    expect(MAX_NESTING).toBe(8);
  });

  it('analyses MAX_NESTING levels and rejects one more', () => {
    expect(typeof MAX_NESTING).toBe('number');
    expect(analyzeCommand(nest(MAX_NESTING))).not.toBeNull();
    expect(analyzeCommand(nest(MAX_NESTING + 1))).toBeNull();
  });

  it('approves the deepest analysable command and denies one level deeper under an unrelated Bash deny rule', () => {
    expect(typeof MAX_NESTING).toBe('number');
    const rules = [['deny', 'Bash(curl:*)']] as const;
    expect(kindIn(commandRow(nest(MAX_NESTING), { rules }), 'manual')).toBe('allow');
    expect(kindIn(commandRow(nest(MAX_NESTING + 1), { rules }), 'manual')).toBe('deny');
  });
});
