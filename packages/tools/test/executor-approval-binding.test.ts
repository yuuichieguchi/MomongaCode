import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { NeedsApprovalOutcome, ToolCall } from '@momonga/tools';
import { approvalOf, makeBuiltins, resultOf } from './builtins/fixtures.ts';

const HEX_DIGEST = /^[0-9a-f]{64}$/;

const setup = async () => {
  const tools = await makeBuiltins();
  const dir = path.join(tools.layout.project, 'dir');
  const other = path.join(tools.layout.project, 'other');
  fs.mkdirSync(dir);
  fs.mkdirSync(other);
  const target = path.join(dir, 'file.txt');
  const args = { file_path: target, content: 'approved content' };
  const swapDirForSymlink = (): void => {
    fs.rmSync(dir, { recursive: true });
    fs.symlinkSync(other, dir, 'dir');
  };
  return { tools, dir, other, target, args, swapDirForSymlink };
};

const digestOf = (outcome: NeedsApprovalOutcome): string => {
  expect(outcome.subjectDigest).toMatch(HEX_DIGEST);
  return outcome.subjectDigest;
};

describe('approval binding by subject digest', () => {
  it('reports the same digest for the same unchanged subject', async () => {
    const { tools, args } = await setup();
    const first = digestOf(approvalOf(await tools.run('Write', args, {}, undefined, 'w1')));
    const second = digestOf(approvalOf(await tools.run('Write', args, {}, undefined, 'w1')));
    expect(second).toBe(first);
  });

  it('proceeds when the resend carries the digest of the unchanged subject', async () => {
    const { tools, target, args } = await setup();
    const subjectDigest = digestOf(approvalOf(await tools.run('Write', args, {}, undefined, 'w1')));
    const result = resultOf(await tools.run('Write', args, {}, { kind: 'allow_once', subjectDigest }, 'w1'));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(target, 'utf8')).toBe('approved content');
  });

  it('asks again with a new digest when a parent directory was swapped for a symlink after approval', async () => {
    const { tools, other, args, swapDirForSymlink } = await setup();
    const approvedDigest = digestOf(approvalOf(await tools.run('Write', args, {}, undefined, 'w1')));
    swapDirForSymlink();
    const again = approvalOf(await tools.run('Write', args, {}, { kind: 'allow_once', subjectDigest: approvedDigest }, 'w1'));
    expect(again.callId).toBe('w1');
    expect(again.decision.kind).toBe('ask');
    expect(digestOf(again)).not.toBe(approvedDigest);
    expect(fs.existsSync(path.join(other, 'file.txt'))).toBe(false);
    expect(tools.idempotency.records.size).toBe(0);
  });

  it('accepts the new digest after the user approves the changed subject', async () => {
    const { tools, other, args, swapDirForSymlink } = await setup();
    const approvedDigest = digestOf(approvalOf(await tools.run('Write', args, {}, undefined, 'w1')));
    swapDirForSymlink();
    const reasked = digestOf(approvalOf(await tools.run('Write', args, {}, { kind: 'allow_always', subjectDigest: approvedDigest }, 'w1')));
    const result = resultOf(await tools.run('Write', args, {}, { kind: 'allow_always', subjectDigest: reasked }, 'w1'));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(path.join(other, 'file.txt'), 'utf8')).toBe('approved content');
  });

  it('does not honor a bare string approval, asking again instead of proceeding', async () => {
    const { tools, target, args } = await setup();
    approvalOf(await tools.run('Write', args, {}, undefined, 'w1'));
    const bare = { callId: 'w1', name: 'Write', arguments: args, approval: 'allow_once' as unknown as NonNullable<ToolCall['approval']> };
    const [outcome] = await tools.executor.runBatch({ ...(await tools.batch('Write', args, {}, undefined, 'w1')), calls: [bare] });
    expect(approvalOf(outcome).callId).toBe('w1');
    expect(fs.existsSync(target)).toBe(false);
    expect(tools.idempotency.records.size).toBe(0);
  });

  it('types an approval only as the subject-bound object form', () => {
    expectTypeOf<ToolCall['approval']>().toEqualTypeOf<{ kind: 'allow_once' | 'allow_always'; subjectDigest: string } | undefined>();
  });
});
