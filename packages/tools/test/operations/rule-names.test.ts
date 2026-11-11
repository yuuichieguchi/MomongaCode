import { describe, expect, it } from 'vitest';
import { OPERATION_RULE_TOOLS, parseRule } from '@momonga/config';
import { OPERATION_SPECS } from '@momonga/tools';

const rule = (text: string) => parseRule(text, { effect: 'allow', origin: 'user', source: 'test', settingsRoot: '/work', home: '/home', cwd: '/work' });

describe('permission rules for operations', () => {
  it('name exactly the operations of the catalogue', () => {
    expect([...OPERATION_RULE_TOOLS].sort()).toEqual(OPERATION_SPECS.map((spec) => spec.name).sort());
  });

  it.each(OPERATION_SPECS.map((spec) => spec.name))('parse for %s with and without a specifier', (name) => {
    expect(rule(name)).toMatchObject({ tool: name });
    expect(rule(`${name}(*)`)).toMatchObject({ tool: name, specifier: '*' });
  });

  it('refuse parentheses inside the specifier of an operation rule', () => {
    expect(() => rule('GitPush(origin:(x))')).toThrow();
  });
});
