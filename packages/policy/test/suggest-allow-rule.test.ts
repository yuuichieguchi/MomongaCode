import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCanonicalPath } from '@momonga/foundation';
import { matchRule, parseRule, suggestAllowRule } from '@momonga/policy';
import type { PermissionSubject, PolicyTool } from '@momonga/policy';
import { fileRulesFor, makeLayout, touch } from './helpers.ts';
import type { Layout } from './helpers.ts';

const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec' };
const READ: PolicyTool = { name: 'Read', kind: 'read', sideEffect: 'read_only' };
const EDIT: PolicyTool = { name: 'Edit', kind: 'edit', sideEffect: 'write' };
const WRITE: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write' };
const MCP: PolicyTool = { name: 'mcp__files__list', kind: 'other', sideEffect: 'read_only' };
const PLAN: PolicyTool = { name: 'UpdatePlan', kind: 'think', sideEffect: 'read_only' };

const cwdOf = (layout: Layout): string => layout.project;

const roundTrip = (layout: Layout, text: string, subject: PermissionSubject): boolean =>
  matchRule(parseRule(text, { effect: 'allow', origin: 'local', source: 'local-settings', settingsRoot: layout.project, home: layout.home, cwd: layout.project }), subject, fileRulesFor([parseRule(text, { effect: 'allow', origin: 'local', source: 'local-settings', settingsRoot: layout.project, home: layout.home, cwd: layout.project })], [layout.project]), 0);

const command = (text: string): PermissionSubject => ({ kind: 'command', tool: 'Bash', command: text });

describe('suggestAllowRule', () => {
  it.each(['npm run build', 'git status', 'make -j4 test'])('suggests the exact simple command %j', (text) => {
    const layout = makeLayout();
    const rule = suggestAllowRule(BASH, command(text), cwdOf(layout), resolveCanonicalPath);
    expect(rule).toBe(`Bash(${text})`);
    expect(roundTrip(layout, rule as string, command(text))).toBe(true);
  });

  it.each([
    ['and list', 'git add . && git commit -m x'],
    ['or list', 'make || true'],
    ['sequence', 'ls; pwd'],
    ['pipeline', 'ls | wc -l'],
    ['command substitution', 'echo $(whoami)'],
    ['backtick substitution', 'echo `whoami`'],
    ['output redirect', 'echo x > out.txt'],
    ['input redirect', 'wc -l < in.txt'],
    ['background', 'sleep 1 &'],
  ])('returns undefined for a %s', (_label, text) => {
    const layout = makeLayout();
    expect(suggestAllowRule(BASH, command(text), cwdOf(layout), resolveCanonicalPath)).toBeUndefined();
  });

  it.each([
    ['Read', READ, 'read'],
    ['Edit', EDIT, 'write'],
    ['Write', WRITE, 'write'],
  ] as const)('suggests an absolute-path %s rule covering exactly that path', (name, tool, access) => {
    const layout = makeLayout();
    const target = touch(path.join(layout.project, 'src', 'main.ts'));
    const subject: PermissionSubject = { kind: 'path', tool: name, paths: [target], access };
    const rule = suggestAllowRule(tool, subject, cwdOf(layout), resolveCanonicalPath);
    expect(rule).toBe(`${name}(/${target})`);
    expect(roundTrip(layout, rule as string, subject)).toBe(true);
    const sibling: PermissionSubject = { kind: 'path', tool: name, paths: [touch(path.join(layout.project, 'src', 'other.ts'))], access };
    expect(roundTrip(layout, rule as string, sibling)).toBe(false);
  });

  it('works for paths outside the workspace', () => {
    const layout = makeLayout();
    const target = touch(path.join(layout.outside, 'notes.md'));
    const subject: PermissionSubject = { kind: 'path', tool: 'Read', paths: [target], access: 'read' };
    const rule = suggestAllowRule(READ, subject, cwdOf(layout), resolveCanonicalPath);
    expect(rule).toBe(`Read(/${target})`);
    expect(roundTrip(layout, rule as string, subject)).toBe(true);
  });

  it('returns undefined for multiple paths', () => {
    const layout = makeLayout();
    const subject: PermissionSubject = {
      kind: 'path',
      tool: 'Edit',
      paths: [touch(path.join(layout.project, 'a.ts')), touch(path.join(layout.project, 'b.ts'))],
      access: 'write',
    };
    expect(suggestAllowRule(EDIT, subject, cwdOf(layout), resolveCanonicalPath)).toBeUndefined();
  });

  it('suggests the full MCP tool name', () => {
    const layout = makeLayout();
    const subject: PermissionSubject = { kind: 'mcp', server: 'files', tool: 'list' };
    const rule = suggestAllowRule(MCP, subject, cwdOf(layout), resolveCanonicalPath);
    expect(rule).toBe('mcp__files__list');
    expect(roundTrip(layout, rule as string, subject)).toBe(true);
  });

  it('suggests the bare tool name for subjects without effects', () => {
    const layout = makeLayout();
    const subject: PermissionSubject = { kind: 'none', tool: 'UpdatePlan' };
    const rule = suggestAllowRule(PLAN, subject, cwdOf(layout), resolveCanonicalPath);
    expect(rule).toBe('UpdatePlan');
    expect(roundTrip(layout, rule as string, subject)).toBe(true);
  });

  it.each([
    ['ls src', 'Bash(ls src)'],
    ['rm a', 'Bash(rm a)'],
  ])('suggests %j for a command whose program has targets', (text, expected) => {
    expect(suggestAllowRule(BASH, command(text), cwdOf(makeLayout()), resolveCanonicalPath)).toBe(expected);
  });

  it.each(['echo x > f', 'cat < f'])('suggests nothing for the shell redirection in %j', (text) => {
    expect(suggestAllowRule(BASH, command(text), cwdOf(makeLayout()), resolveCanonicalPath)).toBeUndefined();
  });

  it('resolves a relative path against the cwd string', () => {
    const layout = makeLayout();
    const target = touch(path.join(layout.project, 'rel.txt'));
    const subject: PermissionSubject = { kind: 'path', tool: 'Read', paths: ['rel.txt'], access: 'read' };
    expect(suggestAllowRule(READ, subject, layout.project, resolveCanonicalPath)).toBe(`Read(/${target})`);
  });
});
