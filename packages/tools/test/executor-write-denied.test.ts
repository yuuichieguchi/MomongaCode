import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { protectedSetWith } from '@momonga/testkit';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { minimalPolicyFor } from './helpers.ts';

const pathTool = (access: 'read' | 'write', target: string, runs: string[]) =>
  makeTool('PathTool', {
    kind: access === 'read' ? 'read' : 'edit',
    sideEffect: access === 'read' ? 'read_only' : 'write',
    subjectKind: 'path',
    subject: () => ({ kind: 'path', tool: 'PathTool', paths: [target], access }),
    execute: async () => {
      runs.push(target);
      return { status: 'completed', output: 'touched' };
    },
  });

describe('executor: writeDenied path subjects', () => {
  it('denies a write inside a writeDenied entry even in bypassPermissions with approval', async () => {
    const harness = makeHarness();
    const sessions = path.join(harness.layout.project, 'sessions');
    fs.mkdirSync(path.join(sessions, 'other'), { recursive: true });
    const target = path.join(sessions, 'other', 'f');
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(pathTool('write', target, runs)), [call('c1', 'PathTool', {}, 'allow_once')], {
        mode: 'bypassPermissions',
        sandboxPolicy: { ...(await minimalPolicyFor({ layout: harness.layout })), writeDenied: [sessions] },
      }),
    );
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'failed' } });
    expect((outcome as { result: { output: string } }).result.output).toMatch(/^Permission denied: /);
    expect(runs).toEqual([]);
  });

  it('denies a write that reaches a writeDenied entry through a symlink', async () => {
    const harness = makeHarness();
    const keychains = momongaLayout(harness.layout.home).keychains;
    fs.mkdirSync(keychains, { recursive: true });
    const link = path.join(harness.layout.project, 'innocent');
    fs.symlinkSync(keychains, link);
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(pathTool('write', path.join(link, 'x'), runs)), [call('c1', 'PathTool', {}, 'allow_once')], {
        mode: 'bypassPermissions',
        sandboxPolicy: { ...(await minimalPolicyFor({ layout: harness.layout })), writeDenied: [keychains] },
      }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect((outcome as { result: { output: string } }).result.output).toMatch(/^Permission denied: /);
    expect(runs).toEqual([]);
  });

  it('names the resolved form a write through a symlink was denied on, as read access and file rules do', async () => {
    const harness = makeHarness();
    const keychains = momongaLayout(harness.layout.home).keychains;
    fs.mkdirSync(keychains, { recursive: true });
    const link = path.join(harness.layout.project, 'innocent');
    fs.symlinkSync(keychains, link);
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(pathTool('write', path.join(link, 'x'), runs)), [call('c1', 'PathTool', {}, 'allow_once')], {
        mode: 'bypassPermissions',
        sandboxPolicy: { ...(await minimalPolicyFor({ layout: harness.layout })), writeDenied: [keychains] },
      }),
    );
    const reason = `${path.join(fs.realpathSync.native(keychains), 'x')} is write-protected by the sandbox policy`;
    expect(outcome).toEqual({ callId: 'c1', kind: 'result', result: { status: 'failed', output: `Permission denied: ${reason}`, denial: { source: 'sandbox', reason } } });
    expect(runs).toEqual([]);
  });

  it('names the requested form, relative to the working directory, when the write was denied on it', async () => {
    const harness = makeHarness();
    const sessions = path.join(harness.layout.project, 'sessions');
    fs.mkdirSync(path.join(sessions, 'other'), { recursive: true });
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(pathTool('write', path.join(sessions, 'other', 'f'), runs)), [call('c1', 'PathTool', {}, 'allow_once')], {
        mode: 'bypassPermissions',
        sandboxPolicy: { ...(await minimalPolicyFor({ layout: harness.layout })), writeDenied: [sessions] },
      }),
    );
    expect((outcome as { result: { output: string } }).result.output).toBe(`Permission denied: ${path.join('sessions', 'other', 'f')} is write-protected by the sandbox policy`);
  });

  it('guards a writeDenied entry below a non-directory placeholder instead of throwing ENOTDIR', async () => {
    const harness = makeHarness();
    const placeholder = path.join(harness.layout.project, 'protected');
    fs.writeFileSync(placeholder, '');
    const deniedBelow = path.join(placeholder, 'inner', 'secret');
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(pathTool('write', path.join(deniedBelow, 'f'), runs)), [call('c1', 'PathTool', {}, 'allow_once')], {
        mode: 'bypassPermissions',
        sandboxPolicy: { ...(await minimalPolicyFor({ layout: harness.layout })), writeDenied: [deniedBelow] },
      }),
    );
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'failed' } });
    expect((outcome as { result: { output: string } }).result.output).toMatch(/^Permission denied: /);
    expect(runs).toEqual([]);
  });

  it('still lets a read inside a writeDenied entry run', async () => {
    const harness = makeHarness();
    const sessions = path.join(harness.layout.project, 'sessions');
    fs.mkdirSync(sessions);
    const target = path.join(sessions, 'f');
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(pathTool('read', target, runs)), [call('c1', 'PathTool')], {
        mode: 'bypassPermissions',
        sandboxPolicy: { ...(await minimalPolicyFor({ layout: harness.layout })), writeDenied: [sessions] },
      }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(runs).toEqual([target]);
  });
});

describe('executor write guard while a placeholder changes during the batch (HIGH-2)', () => {
  const flippingTool = (flip: () => void) =>
    makeTool('Flip', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'path',
      subject: () => ({ kind: 'path', tool: 'Flip', paths: ['flip.txt'], access: 'write' }),
      execute: async () => {
        flip();
        return { status: 'completed', output: 'flipped' };
      },
    });

  const runFlip = async (prepare: (placeholder: string) => void, flip: (placeholder: string) => void) => {
    const harness = makeHarness();
    const placeholder = path.join(harness.layout.project, 'protected');
    prepare(placeholder);
    const deniedBelow = path.join(placeholder, 'hooks');
    const runs: string[] = [];
    const tools = await toolSetOf(flippingTool(() => flip(placeholder)), pathTool('write', path.join(deniedBelow, 'pre-commit'), runs));
    const outcomes = await harness.executor.runBatch(
      await harness.input(tools, [call('c1', 'Flip', {}, 'allow_once'), call('c2', 'PathTool', {}, 'allow_once')], {
        mode: 'bypassPermissions',
        sandboxPolicy: { ...(await minimalPolicyFor({ layout: harness.layout })), writeDenied: [deniedBelow] },
      }),
    );
    return { outcomes, runs };
  };

  it('denies below an entry whose placeholder was removed after the guard was built', async () => {
    const { outcomes, runs } = await runFlip(
      (placeholder) => fs.writeFileSync(placeholder, ''),
      (placeholder) => fs.unlinkSync(placeholder),
    );
    expect(outcomes[0]).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect((outcomes[1] as { result: { output: string } }).result.output).toMatch(/^Permission denied: /);
    expect(runs).toEqual([]);
  });

  it('denies below an entry whose placeholder appeared after the guard was built', async () => {
    const { outcomes, runs } = await runFlip(
      () => undefined,
      (placeholder) => fs.writeFileSync(placeholder, ''),
    );
    expect(outcomes[0]).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect((outcomes[1] as { result: { output: string } }).result.output).toMatch(/^Permission denied: /);
    expect(runs).toEqual([]);
  });

  it('denies a write through a link whose target passes through the entry, whichever state the placeholder is in', async () => {
    const harness = makeHarness();
    const placeholder = path.join(harness.layout.project, 'protected');
    fs.writeFileSync(placeholder, '');
    const link = path.join(harness.layout.project, 'l');
    fs.symlinkSync('protected/hooks/x', link);
    const runs: string[] = [];
    const tools = await toolSetOf(flippingTool(() => fs.unlinkSync(placeholder)), pathTool('write', link, runs));
    const outcomes = await harness.executor.runBatch(
      await harness.input(tools, [call('c1', 'Flip', {}, 'allow_once'), call('c2', 'PathTool', {}, 'allow_once')], {
        mode: 'bypassPermissions',
        sandboxPolicy: { ...(await minimalPolicyFor({ layout: harness.layout })), writeDenied: [path.join(placeholder, 'hooks')] },
      }),
    );
    expect((outcomes[1] as { result: { output: string } }).result.output).toMatch(/^Permission denied: /);
    expect(runs).toEqual([]);
  });

  it('control: a sibling of the entry stays writable after the flip', async () => {
    const harness = makeHarness();
    const placeholder = path.join(harness.layout.project, 'protected');
    fs.writeFileSync(placeholder, '');
    const runs: string[] = [];
    const sibling = path.join(harness.layout.project, 'free.txt');
    const tools = await toolSetOf(flippingTool(() => fs.unlinkSync(placeholder)), pathTool('write', sibling, runs));
    await harness.executor.runBatch(
      await harness.input(tools, [call('c1', 'Flip', {}, 'allow_once'), call('c2', 'PathTool', {}, 'allow_once')], {
        mode: 'bypassPermissions',
        sandboxPolicy: { ...(await minimalPolicyFor({ layout: harness.layout })), writeDenied: [path.join(placeholder, 'hooks')] },
      }),
    );
    expect(runs).toEqual([sibling]);
  });
});

describe('executor write guard and the protected set (V15)', () => {
  it('hard-denies an entry that is both a home guard and protected', async () => {
    const harness = makeHarness();
    const keychains = momongaLayout(harness.layout.home).keychains;
    fs.mkdirSync(keychains, { recursive: true });
    const target = path.join(keychains, 'x');
    const runs: string[] = [];
    const policy = { ...minimalPolicyFor({ layout: harness.layout }), writeDenied: [keychains], protectedSet: protectedSetWith([harness.layout.project], [keychains]) };
    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(pathTool('write', target, runs)), [call('c1', 'PathTool', {}, 'allow_once')], { mode: 'bypassPermissions', sandboxPolicy: await policy }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect(runs).toEqual([]);
  });

  it('does not throw for a paths entry that does not resolve', async () => {
    const harness = makeHarness();
    const loop = path.join(harness.layout.project, 'loop');
    fs.symlinkSync(loop, loop);
    const entry = path.join(loop, 'x');
    const runs: string[] = [];
    const policy = { ...minimalPolicyFor({ layout: harness.layout }), writeDenied: [entry], protectedSet: protectedSetWith([harness.layout.project], [entry]) };
    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(pathTool('write', path.join(harness.layout.project, 'a.txt'), runs)), [call('c1', 'PathTool', {}, 'allow_once')], { mode: 'acceptEdits', sandboxPolicy: await policy }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
  });
});
