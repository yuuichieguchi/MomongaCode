import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionSubject } from '@momonga/policy';
import type { CallOutcome, NeedsApprovalOutcome, ResultOutcome } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { Harness } from './harness.ts';
import { ruleFor } from './helpers.ts';

const PATH_SCHEMA = { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } as const;
const COMMAND_SCHEMA = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } as const;
const MERGE_SCHEMA = { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'], additionalProperties: false } as const;

const MANDATE = { supersededForms: [], coveredPrograms: [] };

const setup = async () => {
  const harness: Harness = makeHarness();
  const executed: string[] = [];
  const ran = async (_input: unknown, ctx: { callId: string }) => {
    executed.push(ctx.callId);
    return { status: 'completed' as const, output: 'ran' };
  };
  const write = makeTool('Write', {
    kind: 'edit',
    sideEffect: 'write',
    subjectKind: 'path',
    inputSchema: PATH_SCHEMA,
    subject: (input): Extract<PermissionSubject, { kind: 'path' }> => ({ kind: 'path', tool: 'Write', paths: [String(input['file_path'])], access: 'write' }),
    execute: ran,
  });
  const read = makeTool('Read', {
    sideEffect: 'read_only',
    subjectKind: 'path',
    inputSchema: PATH_SCHEMA,
    subject: (input): Extract<PermissionSubject, { kind: 'path' }> => ({ kind: 'path', tool: 'Read', paths: [String(input['file_path'])], access: 'read' }),
    execute: ran,
  });
  const bash = makeTool('Bash', {
    kind: 'execute',
    sideEffect: 'exec',
    subjectKind: 'command',
    inputSchema: COMMAND_SCHEMA,
    subject: (input): Extract<PermissionSubject, { kind: 'command' }> => ({ kind: 'command', tool: 'Bash', command: String(input['command']) }),
    execute: ran,
  });
  const merge = makeTool('PullRequestMerge', {
    kind: 'other',
    sideEffect: 'write',
    subjectKind: 'forge',
    inputSchema: MERGE_SCHEMA,
    subject: (input): Extract<PermissionSubject, { kind: 'forge' }> => ({ kind: 'forge', tool: 'PullRequestMerge', operation: 'PullRequestMerge', host: 'forge.example', repo: 'acme/widgets', pr: Number(input['number']), approval: 'always' }),
    execute: ran,
  });
  const echo = makeTool('Echo', { execute: ran });
  const toolSet = await toolSetOf(write, read, bash, merge, echo);
  const rule = ruleFor(harness.layout);
  const inside = (name: string): string => path.join(harness.layout.project, name);
  const rules = [rule('ask', `Write(/${inside('held.txt')})`), rule('allow', 'Write'), rule('allow', 'Read'), rule('allow', 'Bash(cat:*)')];
  const run = (calls: ReturnType<typeof call>[], extra: { hold?: { blockers: Array<{ callId: string; footprint: { reads: string[]; writes: string[] } }> }; held?: boolean } = {}): Promise<CallOutcome[]> =>
    harness.executor.runBatch(harness.input(toolSet, calls, { rules, ...(extra.held === false ? {} : { mandate: MANDATE, hold: extra.hold ?? { blockers: [] } }) }));
  return { harness, executed, inside, run };
};

const kindsOf = (outcomes: readonly CallOutcome[]): Array<[string, string]> => outcomes.map((outcome) => [outcome.callId, outcome.kind]);

const resultOf = (outcome: CallOutcome | undefined): ResultOutcome['result'] => {
  expect(outcome?.kind).toBe('result');
  return (outcome as ResultOutcome).result;
};

describe('a batch in hold mode', () => {
  it('holds the call that asks, with its footprint, and runs every other call of the batch that does not touch it', async () => {
    const { executed, inside, run } = await setup();
    const outcomes = await run([call('cHeld', 'Write', { file_path: inside('held.txt') }), call('cRead', 'Read', { file_path: inside('other.txt') }), call('cWrite', 'Write', { file_path: inside('free.txt') }), call('cEcho', 'Echo', { value: 'x' })]);
    expect(kindsOf(outcomes)).toEqual([
      ['cHeld', 'needs_approval'],
      ['cRead', 'result'],
      ['cWrite', 'result'],
      ['cEcho', 'result'],
    ]);
    expect((outcomes[0] as NeedsApprovalOutcome).footprint).toEqual({ reads: [], writes: [`local:${inside('held.txt')}`] });
    expect([...executed].sort()).toEqual(['cEcho', 'cRead', 'cWrite']);
  });

  it('without hold mode stops at the call that asks and defers the calls after it', async () => {
    const { executed, inside, run } = await setup();
    const outcomes = await run([call('cHeld', 'Write', { file_path: inside('held.txt') }), call('cWrite', 'Write', { file_path: inside('free.txt') })], { held: false });
    expect(kindsOf(outcomes)).toEqual([
      ['cHeld', 'needs_approval'],
      ['cWrite', 'deferred'],
    ]);
    expect(executed).toEqual([]);
  });

  it('blocks a later call of the same batch that reads or writes what the held call writes, and asks about neither', async () => {
    const { executed, inside, run } = await setup();
    const outcomes = await run([call('cHeld', 'Write', { file_path: inside('held.txt') }), call('cSameRead', 'Read', { file_path: inside('held.txt') }), call('cShell', 'Bash', { command: 'cat held.txt' })]);
    expect(kindsOf(outcomes)).toEqual([
      ['cHeld', 'needs_approval'],
      ['cSameRead', 'result'],
      ['cShell', 'result'],
    ]);
    for (const blocked of [outcomes[1], outcomes[2]]) {
      const result = resultOf(blocked);
      expect(result).toMatchObject({ status: 'failed', denial: { source: 'held' } });
      expect(result.output).toContain('blocked by the held call cHeld (same path or ref)');
    }
    expect(executed).toEqual([]);
  });

  it('blocks a call of a later batch by the calls held before it, which the batch is given', async () => {
    const { executed, inside, run } = await setup();
    const blockers = [{ callId: 'cEarlier', footprint: { reads: [], writes: [`local:${inside('held.txt')}`] } }];
    const outcomes = await run([call('cSameRead', 'Read', { file_path: inside('held.txt') }), call('cOther', 'Read', { file_path: inside('other.txt') })], { hold: { blockers } });
    expect(resultOf(outcomes[0]).output).toContain('blocked by the held call cEarlier');
    expect(resultOf(outcomes[1]).status).toBe('completed');
    expect(executed).toEqual(['cOther']);
  });

  it('does not block a shell command by a held pull request merge, whose footprint is the pull request and no local path', async () => {
    const { executed, run } = await setup();
    const outcomes = await run([call('cMerge', 'PullRequestMerge', { number: 7 }), call('cShell', 'Bash', { command: 'cat a.txt' }), call('cMergeAgain', 'PullRequestMerge', { number: 7 })]);
    expect(outcomes[0]).toMatchObject({ kind: 'needs_approval', footprint: { reads: [], writes: ['pr:forge.example/acme/widgets#7'] } });
    expect(resultOf(outcomes[1]).status).toBe('completed');
    expect(resultOf(outcomes[2])).toMatchObject({ status: 'failed', denial: { source: 'held' } });
    expect(executed).toEqual(['cShell']);
  });

  it('runs a held call that a person approved, once, even though its own footprint is among the blockers', async () => {
    const { harness, executed, inside, run } = await setup();
    const [asked] = await run([call('cHeld', 'Write', { file_path: inside('held.txt') })]);
    const approved = { ...call('cHeld', 'Write', { file_path: inside('held.txt') }), approval: { kind: 'allow_once' as const, subjectDigest: (asked as NeedsApprovalOutcome).subjectDigest } };
    const blockers = [{ callId: 'cHeld', footprint: { reads: [], writes: [`local:${inside('held.txt')}`] } }];
    const [first] = await run([approved], { hold: { blockers } });
    expect(resultOf(first).status).toBe('completed');
    const [second] = await run([approved], { hold: { blockers } });
    expect(resultOf(second).status).toBe('completed');
    expect(executed).toEqual(['cHeld']);
    expect(harness.started).toEqual(['cHeld']);
  });
});
