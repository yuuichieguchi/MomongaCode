import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionSubject } from '@momonga/policy';
import { EMPTY_FOOTPRINT, blockerOf, footprintOf, footprintsConflict } from '../src/footprint.ts';
import type { Footprint } from '../src/footprint.ts';

const CWD = path.resolve('/work/project');

const of = (subject: PermissionSubject): Footprint => footprintOf(subject, CWD);

const write = (file: string): Footprint => of({ kind: 'path', tool: 'Write', paths: [file], access: 'write' });
const read = (file: string): Footprint => of({ kind: 'path', tool: 'Read', paths: [file], access: 'read' });
const bash = of({ kind: 'command', tool: 'Bash', command: 'npm test' });
const commit = of({ kind: 'repo', tool: 'GitCommit', operation: 'GitCommit', remote: null, refs: [], destinations: [], destinationsMatchFetch: true, approval: 'rule' });
const push = (ref: string, destinations: string[] = ['https://forge.example/acme/widgets.git']): Footprint =>
  of({ kind: 'repo', tool: 'GitPush', operation: 'GitPush', remote: 'origin', refs: [ref], destinations, destinationsMatchFetch: true, approval: 'rule' });
const mcp = of({ kind: 'mcp', server: 'tracker', tool: 'close_issue' });
const merge = (pr: number): Footprint => of({ kind: 'forge', tool: 'PullRequestMerge', operation: 'PullRequestMerge', host: 'forge.example', repo: 'acme/widgets', pr, approval: 'always' });

describe('the footprint of a call, from its permission subject', () => {
  it('is the paths a file tool reads or writes, resolved against the working directory', () => {
    expect(write('a.txt')).toEqual({ reads: [], writes: [`local:${path.join(CWD, 'a.txt')}`] });
    expect(read('/etc/hosts')).toEqual({ reads: ['local:/etc/hosts'], writes: [] });
  });

  it('is every local path for a shell command and for a local git operation', () => {
    expect(bash).toEqual({ reads: ['local:*'], writes: ['local:*'] });
    expect(commit).toEqual(bash);
  });

  it('is the remote refs a push writes, at every destination, and the local tree it reads', () => {
    expect(push('main', ['file:///a.git', 'file:///b.git'])).toEqual({ reads: ['local:*'], writes: ['ref:file:///a.git:main', 'ref:file:///b.git:main'] });
  });

  it('is the pull request a forge operation changes', () => {
    expect(merge(7)).toEqual({ reads: [], writes: ['pr:forge.example/acme/widgets#7'] });
  });

  it('is empty for a call the design gives no path, ref or pull request', () => {
    expect(of({ kind: 'none', tool: 'UpdatePlan' })).toBe(EMPTY_FOOTPRINT);
    expect(of({ kind: 'memory', tool: 'MemorySave', scope: 'project' } as PermissionSubject)).toBe(EMPTY_FOOTPRINT);
  });

  it('is everything for an MCP call, whose effects the product cannot name', () => {
    expect(mcp).toEqual({ reads: ['*'], writes: ['*'] });
  });
});

describe('two calls conflict when one writes what the other reads or writes', () => {
  const cases: ReadonlyArray<readonly [string, Footprint, Footprint, boolean]> = [
    ['two writes of one file', write('a.txt'), write('a.txt'), true],
    ['a write and a read of one file', write('a.txt'), read('a.txt'), true],
    ['two reads of one file', read('a.txt'), read('a.txt'), false],
    ['writes of two files', write('a.txt'), write('b.txt'), false],
    ['a write under a directory another call reads', write('src/a.txt'), read('src'), true],
    ['a shell command and a write of a local file', bash, write('a.txt'), true],
    ['a shell command and a read of a local file', bash, read('a.txt'), true],
    ['two shell commands', bash, bash, true],
    ['a shell command and a merge of a pull request', bash, merge(7), false],
    ['a commit and a push, which reads the local tree', commit, push('main'), true],
    ['a write of a local file and a push', write('a.txt'), push('main'), true],
    ['a read of a local file and a push', read('a.txt'), push('main'), false],
    ['two pushes of one ref', push('main'), push('main'), true],
    ['pushes of two refs', push('main'), push('feature/x'), false],
    ['merges of two pull requests', merge(7), merge(8), false],
    ['two merges of one pull request', merge(7), merge(7), true],
    ['a call with no footprint and anything', EMPTY_FOOTPRINT, bash, false],
    ['an MCP call and a write of a local file', mcp, write('a.txt'), true],
    ['an MCP call and a read of a local file', mcp, read('a.txt'), true],
    ['an MCP call and a merge of a pull request', mcp, merge(7), true],
    ['an MCP call and a push', mcp, push('main'), true],
    ['an MCP call and a shell command', mcp, bash, true],
    ['two MCP calls', mcp, mcp, true],
    ['an MCP call and a call with no footprint', mcp, EMPTY_FOOTPRINT, false],
  ];

  it.each(cases)('%s', (_label, left, right, expected) => {
    expect(footprintsConflict(left, right)).toBe(expected);
    expect(footprintsConflict(right, left)).toBe(expected);
  });

  it('names the held call that blocks, and none when nothing conflicts', () => {
    const held = [{ callId: 'call_merge', footprint: merge(7) }, { callId: 'call_write', footprint: write('a.txt') }];
    expect(blockerOf(bash, held)?.callId).toBe('call_write');
    expect(blockerOf(read('b.txt'), held)).toBeUndefined();
    expect(blockerOf(merge(7), held)?.callId).toBe('call_merge');
    expect(blockerOf(mcp, held)?.callId).toBe('call_merge');
    expect(blockerOf(mcp, [])).toBeUndefined();
  });
});
