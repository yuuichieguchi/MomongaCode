import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchRule, parseRule } from '@momonga/policy';
import { makeLayout, ruleIn, touch } from './helpers.ts';

describe('matchRule paths', () => {
  it('resolves //, ~/, /, ./ and bare specifiers against absolute, home, settings root and cwd', () => {
    const layout = makeLayout();
    const cwd = path.join(layout.project, 'pkg');
    const make = (text: string) =>
      parseRule(text, { effect: 'allow', origin: 'project', source: 's', settingsRoot: layout.settingsRoot, home: layout.home, cwd });
    const read = (file: string) => ({ kind: 'path', tool: 'Read', paths: [touch(file)], access: 'read' }) as const;

    expect(matchRule(make(`Read(/${layout.outside}/**)`), read(path.join(layout.outside, 'a.txt')))).toBe(true);
    expect(matchRule(make('Read(~/notes/**)'), read(path.join(layout.home, 'notes', 'n.md')))).toBe(true);
    expect(matchRule(make('Read(~/notes/**)'), read(path.join(cwd, 'notes', 'n.md')))).toBe(false);
    expect(matchRule(make('Read(/docs/**)'), read(path.join(layout.settingsRoot, 'docs', 'd.md')))).toBe(true);
    expect(matchRule(make('Read(/docs/**)'), read(path.join(cwd, 'docs', 'd.md')))).toBe(false);
    expect(matchRule(make('Read(./src/**)'), read(path.join(cwd, 'src', 'deep', 'f.ts')))).toBe(true);
    expect(matchRule(make('Read(./src/**)'), read(path.join(layout.settingsRoot, 'src', 'f.ts')))).toBe(false);
    expect(matchRule(make('Read(src/**)'), read(path.join(cwd, 'src', 'f.ts')))).toBe(true);
    expect(matchRule(make('Read(*.secret)'), read(path.join(cwd, 'a', 'b', 'k.secret')))).toBe(true);
    expect(matchRule(make('Read(*.secret)'), read(path.join(cwd, 'a', 'k.txt')))).toBe(false);
  });

  it('a tool-only rule matches any subject of that tool and no other tool', () => {
    const layout = makeLayout();
    const rule = ruleIn(layout)('allow', 'Read');
    const file = touch(path.join(layout.outside, 'z'));
    expect(matchRule(rule, { kind: 'path', tool: 'Read', paths: [file], access: 'read' })).toBe(true);
    expect(matchRule(rule, { kind: 'path', tool: 'Grep', paths: [file], access: 'read' })).toBe(false);
  });

  it('does not let a symlink inside the project escape to an outside target', () => {
    const layout = makeLayout();
    touch(path.join(layout.outside, 'secret.txt'));
    fs.symlinkSync(layout.outside, path.join(layout.project, 'link'));
    const viaLink = path.join(layout.project, 'link', 'secret.txt');
    const rule = ruleIn(layout);
    expect(matchRule(rule('allow', 'Read(./**)'), { kind: 'path', tool: 'Read', paths: [viaLink], access: 'read' })).toBe(false);
    expect(
      matchRule(rule('deny', `Read(/${layout.outside}/**)`), { kind: 'path', tool: 'Read', paths: [viaLink], access: 'read' }),
    ).toBe(true);
  });

  it('does not let a symlinked file escape either', () => {
    const layout = makeLayout();
    const target = touch(path.join(layout.outside, 'f.txt'));
    const link = path.join(layout.project, 'f.txt');
    fs.symlinkSync(target, link);
    expect(matchRule(ruleIn(layout)('allow', 'Edit(./**)'), { kind: 'path', tool: 'Edit', paths: [link], access: 'write' })).toBe(false);
  });

  it('normalizes .. segments before matching', () => {
    const layout = makeLayout();
    touch(path.join(layout.outside, 'f.txt'));
    fs.mkdirSync(path.join(layout.project, 'src'));
    const sneaky = path.join(layout.project, 'src') + '/../../outside/f.txt';
    expect(matchRule(ruleIn(layout)('allow', 'Read(./**)'), { kind: 'path', tool: 'Read', paths: [sneaky], access: 'read' })).toBe(false);
  });

  it('matches not-yet-existing write targets by the realpath of their nearest existing ancestor', () => {
    const layout = makeLayout();
    fs.symlinkSync(layout.outside, path.join(layout.project, 'link'));
    const rule = ruleIn(layout)('allow', 'Write(./**)');
    const fresh = path.join(layout.project, 'new', 'dir', 'file.txt');
    const escaped = path.join(layout.project, 'link', 'new', 'file.txt');
    expect(matchRule(rule, { kind: 'path', tool: 'Write', paths: [fresh], access: 'write' })).toBe(true);
    expect(matchRule(rule, { kind: 'path', tool: 'Write', paths: [escaped], access: 'write' })).toBe(false);
  });

  it('allow rules require every path to match while deny rules match on any path', () => {
    const layout = makeLayout();
    const inside = touch(path.join(layout.project, 'src', 'a.ts'));
    const other = touch(path.join(layout.project, 'other', 'b.ts'));
    const subject = { kind: 'path', tool: 'Grep', paths: [inside, other], access: 'read' } as const;
    expect(matchRule(ruleIn(layout)('allow', 'Grep(./src/**)'), subject)).toBe(false);
    expect(matchRule(ruleIn(layout)('deny', 'Grep(./src/**)'), subject)).toBe(true);
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
  ])('allow %s vs %j -> %s', (text, command, expected) => {
    const layout = makeLayout();
    expect(matchRule(ruleIn(layout)('allow', text), { kind: 'command', tool: 'Bash', command })).toBe(expected);
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
  ])('deny Bash(rm:*) vs %j -> %s', (command, expected) => {
    const layout = makeLayout();
    expect(matchRule(ruleIn(layout)('deny', 'Bash(rm:*)'), { kind: 'command', tool: 'Bash', command })).toBe(expected);
  });
});

describe('matchRule mcp and none', () => {
  it('matches server-wide and exact tool rules', () => {
    const layout = makeLayout();
    const rule = ruleIn(layout);
    expect(matchRule(rule('allow', 'mcp__github'), { kind: 'mcp', server: 'github', tool: 'create_issue' })).toBe(true);
    expect(matchRule(rule('allow', 'mcp__github'), { kind: 'mcp', server: 'githubx', tool: 'create_issue' })).toBe(false);
    expect(matchRule(rule('allow', 'mcp__github__create_issue'), { kind: 'mcp', server: 'github', tool: 'create_issue' })).toBe(true);
    expect(matchRule(rule('allow', 'mcp__github__create_issue'), { kind: 'mcp', server: 'github', tool: 'delete_repo' })).toBe(false);
  });

  it('matches tool-only rules on none subjects', () => {
    const layout = makeLayout();
    expect(matchRule(ruleIn(layout)('deny', 'UpdatePlan'), { kind: 'none', tool: 'UpdatePlan' })).toBe(true);
    expect(matchRule(ruleIn(layout)('deny', 'UpdatePlan'), { kind: 'none', tool: 'ReadOutput' })).toBe(false);
  });
});
