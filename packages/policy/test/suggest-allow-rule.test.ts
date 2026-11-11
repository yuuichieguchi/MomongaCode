import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { matchRule, parseRule, suggestAllowRule } from '@momonga/policy';

import type { PermissionSubject, PolicyTool } from '@momonga/policy';
import { fileRulesFor, makeLayout, touch } from './helpers.ts';

import type { Layout } from './helpers.ts';
import { testProbes } from '@momonga/testkit';
import { syncPaths } from '@momonga/foundation';


const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' };
const READ: PolicyTool = { name: 'Read', kind: 'read', sideEffect: 'read_only' };
const EDIT: PolicyTool = { name: 'Edit', kind: 'edit', sideEffect: 'write', subjectKind: 'path' };
const WRITE: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write', subjectKind: 'path' };
const MCP: PolicyTool = { name: 'mcp__files__list', kind: 'other', sideEffect: 'read_only' };
const PLAN: PolicyTool = { name: 'UpdatePlan', kind: 'think', sideEffect: 'read_only' };

const cwdOf = (layout: Layout): string => layout.project;

const roundTrip = async (layout: Layout, text: string, subject: PermissionSubject): Promise<boolean> =>
  await matchRule(parseRule(text, { effect: 'allow', origin: 'local', source: 'local-settings', settingsRoot: layout.project, home: layout.home, cwd: layout.project }), subject, await fileRulesFor([parseRule(text, { effect: 'allow', origin: 'local', source: 'local-settings', settingsRoot: layout.project, home: layout.home, cwd: layout.project })], [layout.project]), 0, testProbes().canonicalise);

const command = (text: string): PermissionSubject => ({ kind: 'command', tool: 'Bash', command: text });

describe('suggestAllowRule', () => {
  it.each(['npm run build', 'git status', 'make -j4 test'])('suggests the exact simple command %j', async (text) => {
    const layout = makeLayout();
    const rule = await suggestAllowRule(BASH, command(text), cwdOf(layout), syncPaths.resolveCanonicalPath);
    expect(rule).toBe(`Bash(${text})`);
    expect(await roundTrip(layout, rule as string, command(text))).toBe(true);
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
  ])('returns undefined for a %s', async (_label, text) => {
    const layout = makeLayout();
    expect(await suggestAllowRule(BASH, command(text), cwdOf(layout), syncPaths.resolveCanonicalPath)).toBeUndefined();
  });

  it.each([
    ['Read', READ, 'read'],
    ['Edit', EDIT, 'write'],
    ['Write', WRITE, 'write'],
  ] as const)('suggests an absolute-path %s rule covering exactly that path', async (name, tool, access) => {
    const layout = makeLayout();
    const target = touch(path.join(layout.project, 'src', 'main.ts'));
    const subject: PermissionSubject = { kind: 'path', tool: name, paths: [target], access };
    const rule = await suggestAllowRule(tool, subject, cwdOf(layout), syncPaths.resolveCanonicalPath);
    expect(rule).toBe(`${name}(/${target})`);
    expect(await roundTrip(layout, rule as string, subject)).toBe(true);
    const sibling: PermissionSubject = { kind: 'path', tool: name, paths: [touch(path.join(layout.project, 'src', 'other.ts'))], access };
    expect(await roundTrip(layout, rule as string, sibling)).toBe(false);
  });

  it('works for paths outside the workspace', async () => {
    const layout = makeLayout();
    const target = touch(path.join(layout.outside, 'notes.md'));
    const subject: PermissionSubject = { kind: 'path', tool: 'Read', paths: [target], access: 'read' };
    const rule = await suggestAllowRule(READ, subject, cwdOf(layout), syncPaths.resolveCanonicalPath);
    expect(rule).toBe(`Read(/${target})`);
    expect(await roundTrip(layout, rule as string, subject)).toBe(true);
  });

  it('returns undefined for multiple paths', async () => {
    const layout = makeLayout();
    const subject: PermissionSubject = {
      kind: 'path',
      tool: 'Edit',
      paths: [touch(path.join(layout.project, 'a.ts')), touch(path.join(layout.project, 'b.ts'))],
      access: 'write',
    };
    expect(await suggestAllowRule(EDIT, subject, cwdOf(layout), syncPaths.resolveCanonicalPath)).toBeUndefined();
  });

  it('suggests the full MCP tool name', async () => {
    const layout = makeLayout();
    const subject: PermissionSubject = { kind: 'mcp', server: 'files', tool: 'list' };
    const rule = await suggestAllowRule(MCP, subject, cwdOf(layout), syncPaths.resolveCanonicalPath);
    expect(rule).toBe('mcp__files__list');
    expect(await roundTrip(layout, rule as string, subject)).toBe(true);
  });

  it('suggests the bare tool name for subjects without effects', async () => {
    const layout = makeLayout();
    const subject: PermissionSubject = { kind: 'none', tool: 'UpdatePlan' };
    const rule = await suggestAllowRule(PLAN, subject, cwdOf(layout), syncPaths.resolveCanonicalPath);
    expect(rule).toBe('UpdatePlan');
    expect(await roundTrip(layout, rule as string, subject)).toBe(true);
  });

  it.each([
    ['ls src', 'Bash(ls src)'],
    ['rm a', 'Bash(rm a)'],
  ])('suggests %j for a command whose program has targets', async (text, expected) => {
    expect(await suggestAllowRule(BASH, command(text), cwdOf(makeLayout()), syncPaths.resolveCanonicalPath)).toBe(expected);
  });

  it.each(['echo x > f', 'cat < f'])('suggests nothing for the shell redirection in %j', async (text) => {
    expect(await suggestAllowRule(BASH, command(text), cwdOf(makeLayout()), syncPaths.resolveCanonicalPath)).toBeUndefined();
  });

  it('resolves a relative path against the cwd string', async () => {
    const layout = makeLayout();
    const target = touch(path.join(layout.project, 'rel.txt'));
    const subject: PermissionSubject = { kind: 'path', tool: 'Read', paths: ['rel.txt'], access: 'read' };
    expect(await suggestAllowRule(READ, subject, layout.project, syncPaths.resolveCanonicalPath)).toBe(`Read(/${target})`);
  });
});
