import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchRule, parseRule } from '@momonga/policy';
import { fileRulesFor, makeLayout, ruleIn, touch } from './helpers.ts';
import { testProbes } from '@momonga/testkit';

describe('matchRule paths', () => {
  it('resolves //, ~/, /, ./ and bare specifiers against absolute, home, settings root and cwd', async () => {
    const layout = makeLayout();
    const cwd = path.join(layout.project, 'pkg');
    const make = (text: string) =>
      parseRule(text, { effect: 'allow', origin: 'project', source: 's', settingsRoot: layout.settingsRoot, home: layout.home, cwd });
    const read = (file: string) => ({ kind: 'path', tool: 'Read', paths: [touch(file)], access: 'read' }) as const;

    expect(await matchRule(make(`Read(/${layout.outside}/**)`), read(path.join(layout.outside, 'a.txt')), await fileRulesFor([make(`Read(/${layout.outside}/**)`)], [make(`Read(/${layout.outside}/**)`).cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(make('Read(~/notes/**)'), read(path.join(layout.home, 'notes', 'n.md')), await fileRulesFor([make('Read(~/notes/**)')], [make('Read(~/notes/**)').cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(make('Read(~/notes/**)'), read(path.join(cwd, 'notes', 'n.md')), await fileRulesFor([make('Read(~/notes/**)')], [make('Read(~/notes/**)').cwd]), 0, testProbes().canonicalise)).toBe(false);
    expect(await matchRule(make('Read(/docs/**)'), read(path.join(layout.settingsRoot, 'docs', 'd.md')), await fileRulesFor([make('Read(/docs/**)')], [make('Read(/docs/**)').cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(make('Read(/docs/**)'), read(path.join(cwd, 'docs', 'd.md')), await fileRulesFor([make('Read(/docs/**)')], [make('Read(/docs/**)').cwd]), 0, testProbes().canonicalise)).toBe(false);
    expect(await matchRule(make('Read(./src/**)'), read(path.join(cwd, 'src', 'deep', 'f.ts')), await fileRulesFor([make('Read(./src/**)')], [make('Read(./src/**)').cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(make('Read(./src/**)'), read(path.join(layout.settingsRoot, 'src', 'f.ts')), await fileRulesFor([make('Read(./src/**)')], [make('Read(./src/**)').cwd]), 0, testProbes().canonicalise)).toBe(false);
    expect(await matchRule(make('Read(src/**)'), read(path.join(cwd, 'src', 'f.ts')), await fileRulesFor([make('Read(src/**)')], [make('Read(src/**)').cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(make('Read(*.secret)'), read(path.join(cwd, 'a', 'b', 'k.secret')), await fileRulesFor([make('Read(*.secret)')], [make('Read(*.secret)').cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(make('Read(*.secret)'), read(path.join(cwd, 'a', 'k.txt')), await fileRulesFor([make('Read(*.secret)')], [make('Read(*.secret)').cwd]), 0, testProbes().canonicalise)).toBe(false);
  });

  it('a tool-only rule matches any subject of the family of that tool and no other tool', async () => {
    const layout = makeLayout();
    const rule = ruleIn(layout)('allow', 'Read');
    const file = touch(path.join(layout.outside, 'z'));
    expect(await matchRule(rule, { kind: 'path', tool: 'Read', paths: [file], access: 'read' }, await fileRulesFor([rule], [rule.cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(rule, { kind: 'path', tool: 'Grep', paths: [file], access: 'read' }, await fileRulesFor([rule], [rule.cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(rule, { kind: 'path', tool: 'Write', paths: [file], access: 'write' }, await fileRulesFor([rule], [rule.cwd]), 0, testProbes().canonicalise)).toBe(false);
  });

  it('does not let a symlink inside the project escape to an outside target', async () => {
    const layout = makeLayout();
    touch(path.join(layout.outside, 'secret.txt'));
    fs.symlinkSync(layout.outside, path.join(layout.project, 'link'));
    const viaLink = path.join(layout.project, 'link', 'secret.txt');
    const rule = ruleIn(layout);
    expect(await matchRule(rule('allow', 'Read(./**)'), { kind: 'path', tool: 'Read', paths: [viaLink], access: 'read' }, await fileRulesFor([rule('allow', 'Read(./**)')], [rule('allow', 'Read(./**)').cwd]), 0, testProbes().canonicalise)).toBe(false);
    expect(
      await matchRule(rule('deny', `Read(/${layout.outside}/**)`), { kind: 'path', tool: 'Read', paths: [viaLink], access: 'read' }, await fileRulesFor([rule('deny', `Read(/${layout.outside}/**)`)], [rule('deny', `Read(/${layout.outside}/**)`).cwd]), 0, testProbes().canonicalise),
    ).toBe(true);
  });

  it('does not let a symlinked file escape either', async () => {
    const layout = makeLayout();
    const target = touch(path.join(layout.outside, 'f.txt'));
    const link = path.join(layout.project, 'f.txt');
    fs.symlinkSync(target, link);
    expect(await matchRule(ruleIn(layout)('allow', 'Edit(./**)'), { kind: 'path', tool: 'Edit', paths: [link], access: 'write' }, await fileRulesFor([ruleIn(layout)('allow', 'Edit(./**)')], [ruleIn(layout)('allow', 'Edit(./**)').cwd]), 0, testProbes().canonicalise)).toBe(false);
  });

  it('normalizes .. segments before matching', async () => {
    const layout = makeLayout();
    touch(path.join(layout.outside, 'f.txt'));
    fs.mkdirSync(path.join(layout.project, 'src'));
    const sneaky = path.join(layout.project, 'src') + '/../../outside/f.txt';
    expect(await matchRule(ruleIn(layout)('allow', 'Read(./**)'), { kind: 'path', tool: 'Read', paths: [sneaky], access: 'read' }, await fileRulesFor([ruleIn(layout)('allow', 'Read(./**)')], [ruleIn(layout)('allow', 'Read(./**)').cwd]), 0, testProbes().canonicalise)).toBe(false);
  });

  it('matches not-yet-existing write targets by the realpath of their nearest existing ancestor', async () => {
    const layout = makeLayout();
    fs.symlinkSync(layout.outside, path.join(layout.project, 'link'));
    const rule = ruleIn(layout)('allow', 'Write(./**)');
    const fresh = path.join(layout.project, 'new', 'dir', 'file.txt');
    const escaped = path.join(layout.project, 'link', 'new', 'file.txt');
    expect(await matchRule(rule, { kind: 'path', tool: 'Write', paths: [fresh], access: 'write' }, await fileRulesFor([rule], [rule.cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(rule, { kind: 'path', tool: 'Write', paths: [escaped], access: 'write' }, await fileRulesFor([rule], [rule.cwd]), 0, testProbes().canonicalise)).toBe(false);
  });

  it('allow rules require every path to match while deny rules match on any path', async () => {
    const layout = makeLayout();
    const inside = touch(path.join(layout.project, 'src', 'a.ts'));
    const other = touch(path.join(layout.project, 'other', 'b.ts'));
    const subject = { kind: 'path', tool: 'Grep', paths: [inside, other], access: 'read' } as const;
    expect(await matchRule(ruleIn(layout)('allow', 'Grep(./src/**)'), subject, await fileRulesFor([ruleIn(layout)('allow', 'Grep(./src/**)')], [ruleIn(layout)('allow', 'Grep(./src/**)').cwd]), 0, testProbes().canonicalise)).toBe(false);
    expect(await matchRule(ruleIn(layout)('deny', 'Grep(./src/**)'), subject, await fileRulesFor([ruleIn(layout)('deny', 'Grep(./src/**)')], [ruleIn(layout)('deny', 'Grep(./src/**)').cwd]), 0, testProbes().canonicalise)).toBe(true);
  });
});

describe('matchRule commands', () => {
  it.each([
    ['Bash(git status)', 'git status', true],
    ['Bash(git status)', 'git status --short', false],
    ['Bash(git status)', '  git status  ', true],
    ['Bash(npm run test:*)', 'npm run test', true],
    ['Bash(npm run test:*)', 'npm run test -- --watch', true],
    ['Bash(npm run test:*)', 'npm run testing', false],
    ['Bash(npm run test:*)', 'npm  run   test', true],
    ['Bash(npm run test:*)', 'FOO=1 npm run test', false],
    ['Bash(FOO=1 npm run test:*)', 'FOO=1 npm run test', true],
    ['Bash(npm run test:*)', "bash -c 'npm run test'", false],
    ['Bash(npm run test:*)', 'npm run test $(curl x)', false],
    ['Bash(npm run test:*)', 'npm run test `curl x`', false],
    ['Bash(echo $(date))', 'echo $(date)', true],
    ['Bash', 'anything at all; rm -rf /', true],
  ])('allow %s vs %j -> %s', async (text, command, expected) => {
    const layout = makeLayout();
    expect(await matchRule(ruleIn(layout)('allow', text), { kind: 'command', tool: 'Bash', command }, await fileRulesFor([ruleIn(layout)('allow', text)], [ruleIn(layout)('allow', text).cwd]), 0, testProbes().canonicalise)).toBe(expected);
  });

  it.each([
    ['git status; rm -rf ~', true],
    ['git status && rm -rf ~', true],
    ['git status || rm -rf ~', true],
    ['git status | rm -rf ~', true],
    ['git status & rm -rf ~', true],
    ['git status\nrm -rf ~', true],
    ['echo "x; rm -rf ~"', false],
    ["echo 'a && rm -rf ~'", false],
    ['echo x \\; rm -rf ~', false],
  ])('deny Bash(rm:*) vs %j -> %s', async (command, expected) => {
    const layout = makeLayout();
    expect(await matchRule(ruleIn(layout)('deny', 'Bash(rm:*)'), { kind: 'command', tool: 'Bash', command }, await fileRulesFor([ruleIn(layout)('deny', 'Bash(rm:*)')], [ruleIn(layout)('deny', 'Bash(rm:*)').cwd]), 0, testProbes().canonicalise)).toBe(expected);
  });
});

describe('matchRule mcp and none', () => {
  it('matches server-wide and exact tool rules', async () => {
    const layout = makeLayout();
    const rule = ruleIn(layout);
    expect(await matchRule(rule('allow', 'mcp__github'), { kind: 'mcp', server: 'github', tool: 'create_issue' }, await fileRulesFor([rule('allow', 'mcp__github')], [rule('allow', 'mcp__github').cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(rule('allow', 'mcp__github'), { kind: 'mcp', server: 'githubx', tool: 'create_issue' }, await fileRulesFor([rule('allow', 'mcp__github')], [rule('allow', 'mcp__github').cwd]), 0, testProbes().canonicalise)).toBe(false);
    expect(await matchRule(rule('allow', 'mcp__github__create_issue'), { kind: 'mcp', server: 'github', tool: 'create_issue' }, await fileRulesFor([rule('allow', 'mcp__github__create_issue')], [rule('allow', 'mcp__github__create_issue').cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(rule('allow', 'mcp__github__create_issue'), { kind: 'mcp', server: 'github', tool: 'delete_repo' }, await fileRulesFor([rule('allow', 'mcp__github__create_issue')], [rule('allow', 'mcp__github__create_issue').cwd]), 0, testProbes().canonicalise)).toBe(false);
  });

  it('matches tool-only rules on none subjects', async () => {
    const layout = makeLayout();
    expect(await matchRule(ruleIn(layout)('deny', 'UpdatePlan'), { kind: 'none', tool: 'UpdatePlan' }, await fileRulesFor([ruleIn(layout)('deny', 'UpdatePlan')], [ruleIn(layout)('deny', 'UpdatePlan').cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(ruleIn(layout)('deny', 'UpdatePlan'), { kind: 'none', tool: 'ReadOutput' }, await fileRulesFor([ruleIn(layout)('deny', 'UpdatePlan')], [ruleIn(layout)('deny', 'UpdatePlan').cwd]), 0, testProbes().canonicalise)).toBe(false);
  });
});
