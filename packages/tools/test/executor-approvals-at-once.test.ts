import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionSubject } from '@momonga/policy';
import { call, expectedDigestOf, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { ruleFor } from './helpers.ts';

const PATH_SCHEMA = { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } as const;

const writeSubject = (input: Record<string, unknown>): Extract<PermissionSubject, { kind: 'path' }> => ({ kind: 'path', tool: 'Write', paths: [String(input['file_path'])], access: 'write' });

describe('executor asks for every call that needs approval in one batch', () => {
  it('returns needs_approval for each asking call and defers the allowed and denied ones without executing or recording anything', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const write = makeTool('Write', {
      kind: 'edit',
      sideEffect: 'write',
      subjectKind: 'path',
      inputSchema: PATH_SCHEMA,
      subject: writeSubject,
      execute: async (_input, ctx) => {
        executed.push(ctx.callId);
        return { status: 'completed', output: 'written' };
      },
    });
    const target = (name: string) => path.join(harness.layout.outside, name);
    const rule = ruleFor(harness.layout);
    const calls = [
      call('cA', 'Write', { file_path: target('a.txt') }),
      call('cB', 'Write', { file_path: target('b.txt') }),
      call('cC', 'Write', { file_path: target('c.txt') }),
      call('cD', 'Write', { file_path: target('d.txt') }),
    ];

    const outcomes = await harness.executor.runBatch(
      await harness.input(await toolSetOf(write), calls, {
        mode: 'manual',
        rules: [rule('allow', `Write(/${target('c.txt')})`), rule('deny', `Write(/${target('d.txt')})`)],
      }),
    );

    expect(outcomes.map((outcome) => [outcome.callId, outcome.kind])).toEqual([
      ['cA', 'needs_approval'],
      ['cB', 'needs_approval'],
      ['cC', 'deferred'],
      ['cD', 'deferred'],
    ]);
    const digestOf = (name: string) => expectedDigestOf(write, { file_path: target(name) }, harness);
    expect(outcomes[0]).toMatchObject({ subjectDigest: await digestOf('a.txt') });
    expect(outcomes[1]).toMatchObject({ subjectDigest: await digestOf('b.txt') });
    expect(await digestOf('a.txt')).not.toBe(await digestOf('b.txt'));
    expect(outcomes[2]).toEqual({ callId: 'cC', kind: 'deferred' });
    expect(outcomes[3]).toEqual({ callId: 'cD', kind: 'deferred' });
    expect(executed).toEqual([]);
    expect(harness.started).toEqual([]);
    expect(harness.idempotency.log.filter((entry) => entry.op === 'begin')).toEqual([]);
  });

  it('defers a read-only call that would be allowed after an asking Write', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const write = makeTool('Write', { kind: 'edit', sideEffect: 'write', subjectKind: 'path', inputSchema: PATH_SCHEMA, subject: writeSubject });
    const read = makeTool('Read', {
      execute: async (_input, ctx) => {
        executed.push(ctx.callId);
        return { status: 'completed', output: 'read' };
      },
    });

    const outcomes = await harness.executor.runBatch(
      await harness.input(await toolSetOf(write, read), [call('cW', 'Write', { file_path: path.join(harness.layout.outside, 'w.txt') }), call('cR', 'Read')], {
        mode: 'manual',
      }),
    );

    expect(outcomes).toEqual([expect.objectContaining({ callId: 'cW', kind: 'needs_approval' }), { callId: 'cR', kind: 'deferred' }]);
    expect(executed).toEqual([]);
  });
});
