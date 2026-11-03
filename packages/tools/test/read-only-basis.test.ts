import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { PermissionMode } from '@momonga/protocol';
import { makeRealWorkspace } from './real-workspace.ts';
import type { RealWorkspace } from './real-workspace.ts';

const prepared = (): RealWorkspace => {
  const workspace = makeRealWorkspace();
  workspace.initRepository();
  workspace.mkdir('src');
  return workspace;
};

describe('rule 1: only the read-only analysis gives basis read_only', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  const analysed: ReadonlyArray<readonly [PermissionMode, string]> = [
    ['default', 'ls src'],
    ['default', 'cat tracked'],
    ['default', 'git status'],
    ['default', 'cat tracked | wc -l'],
    ['default', 'ls src; pwd'],
    ['plan', 'ls src'],
    ['plan', 'git log -1'],
    ['acceptEdits', 'ls src'],
    ['acceptEdits', 'git diff'],
  ];

  it.each(analysed)('%s mode: %s is allowed by the analysis', (mode, command) => {
    const decision = prepared().decide(command, { mode });
    expect(decision).toMatchObject({ kind: 'allow', source: 'mode', basis: 'read_only' });
  });

  it('an allow rule gives another basis even when the analysis would approve the command', () => {
    const decision = prepared().decide('ls src', { rules: [['allow', 'Bash(ls:*)']] });
    expect(decision).toMatchObject({ kind: 'allow', source: 'rule' });
    expect(decision.basis).toBeDefined();
    expect(decision.basis).not.toBe('read_only');
  });

  it('bypassPermissions gives another basis even for a read-only command', () => {
    const decision = prepared().decide('ls src', { mode: 'bypassPermissions' });
    expect(decision.kind).toBe('allow');
    expect(decision.basis).toBeDefined();
    expect(decision.basis).not.toBe('read_only');
  });

  it('acceptEdits gives another basis for an edit', () => {
    const decision = prepared().decide('touch fresh', { mode: 'acceptEdits' });
    expect(decision.kind).toBe('allow');
    expect(decision.basis).toBeDefined();
    expect(decision.basis).not.toBe('read_only');
  });

  it.each(['touch fresh', 'ls src > out', 'cat /etc/hosts', 'curl https://example.invalid'])('%s is not approved and carries no read_only basis', (command) => {
    const decision = prepared().decide(command);
    expect(decision.kind).toBe('ask');
    expect(decision.basis).not.toBe('read_only');
  });
});

describe('review 1: a command that writes is not read-only, whoever approves the write', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it.each(['echo hi > out', 'ls > out', 'cat tracked >> out'])('acceptEdits approves %s as an edit', (command) => {
    const decision = prepared().decide(command, { mode: 'acceptEdits' });
    expect(decision).toMatchObject({ kind: 'allow', basis: 'mode' });
  });

  it('an allow rule for the target gives the basis rule, not read_only', () => {
    const decision = prepared().decide('echo hi > out', { rules: [['allow', 'Edit(./out)']] });
    expect(decision).toMatchObject({ kind: 'allow' });
    expect(decision.basis).toBe('rule');
  });

  it.each(['ls 2>/dev/null', 'cat tracked > /dev/null', 'ls >/dev/null 2>&1'])('%s stays read-only: /dev/null is not a write', (command) => {
    expect(prepared().decide(command)).toMatchObject({ kind: 'allow', basis: 'read_only' });
  });
});

describe('rule 3: help is not a read form, so a manual viewer variable is never reached', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it.each(['git help status', 'git status --help', 'git --help', 'git help -m status', 'git log --man'])('%s is not approvable as read-only', (command) => {
    const decision = prepared().decide(command);
    expect(decision.kind).toBe('ask');
    expect(decision.basis).not.toBe('read_only');
  });
});

describe('rule 4: the command text cannot undo the git environment', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it.each([
    'GIT_PAGER=/tmp/x git log -1',
    'GIT_CONFIG_COUNT=0 git status',
    'GIT_CONFIG_PARAMETERS=x git status',
    'GIT_OPTIONAL_LOCKS=1 git status',
    'GIT_EXTERNAL_DIFF=/tmp/x git diff',
    'env git status',
    'env GIT_CONFIG_COUNT=0 git status',
    'env -i git status',
    'env -u GIT_CONFIG_COUNT git status',
    '/usr/bin/env git status',
    'export GIT_CONFIG_COUNT=0; git status',
  ])('%s is not approvable as read-only', (command) => {
    const decision = prepared().decide(command);
    expect(decision.kind).toBe('ask');
    expect(decision.basis).not.toBe('read_only');
  });
});
