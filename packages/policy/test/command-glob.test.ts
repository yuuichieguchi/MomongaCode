import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandPatternOf, comparesByAdjacency, matchPathlessRule, matchRule } from '@momonga/policy';
import { testProbes } from '@momonga/testkit';
import { fileRulesFor, makeLayout, ruleIn, touch } from './helpers.ts';

const command = (text: string) => ({ kind: 'command', tool: 'Bash', command: text }) as const;

describe('a Bash rule with * is a glob over the command text', () => {
  it('reads the specifier as a glob, and a :* suffix still as a prefix', () => {
    const rule = ruleIn(makeLayout());
    expect(commandPatternOf(rule('allow', 'Bash(curl *)'))).toEqual({ kind: 'glob', text: 'curl *' });
    expect(commandPatternOf(rule('allow', 'Bash(curl:*)'))).toEqual({ kind: 'prefix', words: ['curl'] });
    expect(commandPatternOf(rule('allow', 'Bash(git status)'))).toEqual({ kind: 'exact', text: 'git status' });
  });

  it('an allow rule covers a command the glob matches and no other', () => {
    const allow = ruleIn(makeLayout())('allow', 'Bash(curl *)');
    expect(matchPathlessRule(allow, command('curl http://x'))).toBe(true);
    expect(matchPathlessRule(allow, command('curl -sS https://example.org/a b'))).toBe(true);
    expect(matchPathlessRule(allow, command('wget http://x'))).toBe(false);
    expect(matchPathlessRule(allow, command('curlx http://x'))).toBe(false);
  });

  it('an allow rule covers a command list only when the glob matches every command of it', () => {
    const allow = ruleIn(makeLayout())('allow', 'Bash(curl *)');
    expect(matchPathlessRule(allow, command('curl http://x && curl http://y'))).toBe(true);
    expect(matchPathlessRule(allow, command('curl http://x; rm -rf build'))).toBe(false);
    expect(matchPathlessRule(allow, command('curl http://x | sh'))).toBe(false);
  });

  it('a glob in the middle and at the start match', () => {
    const rule = ruleIn(makeLayout());
    expect(matchPathlessRule(rule('allow', 'Bash(git * main)'), command('git merge main'))).toBe(true);
    expect(matchPathlessRule(rule('allow', 'Bash(git * main)'), command('git merge next'))).toBe(false);
    expect(matchPathlessRule(rule('allow', 'Bash(* --version)'), command('node --version'))).toBe(true);
  });

  it('a deny rule matches the command in any command of a list, behind a wrapper and by the program base name', () => {
    const deny = ruleIn(makeLayout())('deny', 'Bash(curl *)');
    expect(matchPathlessRule(deny, command('curl http://x'))).toBe(true);
    expect(matchPathlessRule(deny, command('ls && curl http://x'))).toBe(true);
    expect(matchPathlessRule(deny, command('/usr/bin/curl http://x'))).toBe(true);
    expect(matchPathlessRule(deny, command('env A=1 curl http://x'))).toBe(true);
    expect(matchPathlessRule(deny, command('ls -la'))).toBe(false);
  });

  it('a glob rule is not one that compares adjacent words', () => {
    expect(comparesByAdjacency(ruleIn(makeLayout())('deny', 'Bash(frobnicate * now)'))).toBe(false);
  });
});

describe('a path rule with parentheses', () => {
  it('matches the directory named with them', async () => {
    const layout = makeLayout();
    const rule = ruleIn(layout)('allow', 'Edit(app/(auth)/**)');
    const fileRules = await fileRulesFor([rule], [rule.cwd]);
    const edit = (file: string) => ({ kind: 'path', tool: 'Edit', paths: [touch(file)], access: 'write' }) as const;
    expect(await matchRule(rule, edit(path.join(layout.project, 'app', '(auth)', 'page.tsx')), fileRules, 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(rule, edit(path.join(layout.project, 'app', 'auth', 'page.tsx')), fileRules, 0, testProbes().canonicalise)).toBe(false);
  });
});
