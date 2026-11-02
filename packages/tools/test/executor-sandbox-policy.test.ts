import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SideEffect } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { Harness } from './harness.ts';
import { noneSandbox, ruleFor, minimalPolicyFor } from './helpers.ts';

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

const pathTool = (access: 'read' | 'write', target: string, runs: string[]) =>
  makeTool('PathTool', {
    kind: access === 'read' ? 'read' : 'edit',
    sideEffect: access === 'read' ? 'read_only' : 'write',
    subject: () => ({ kind: 'path', tool: 'PathTool', paths: [target], access }),
    execute: async () => {
      runs.push(target);
      return { status: 'completed', output: 'touched' };
    },
  });

const execTool = (runs: string[], sideEffect: SideEffect = 'exec') =>
  makeTool('Bash', {
    kind: 'execute',
    sideEffect,
    subject: () => ({ kind: 'command', tool: 'Bash', command: 'echo hi' }),
    execute: async () => {
      runs.push('ran');
      return { status: 'completed', output: 'ran' };
    },
  });

const deniedPolicy = (harness: Harness, ...readDenied: string[]) => ({ ...minimalPolicyFor({ layout: harness.layout }), readDenied });

describe('executor: readDenied path subjects', () => {
  for (const mode of MODES) {
    for (const access of ['read', 'write'] as const) {
      it(`denies a ${access} inside readDenied in ${mode} mode even with approval`, async () => {
        const harness = makeHarness();
        const vault = path.join(harness.layout.project, 'vault');
        fs.mkdirSync(vault);
        const target = path.join(vault, 'secret.txt');
        const runs: string[] = [];
        const [outcome] = await harness.executor.runBatch(
          harness.input(await toolSetOf(pathTool(access, target, runs)), [call('c1', 'PathTool', {}, 'allow_once')], {
            mode,
            sandboxPolicy: deniedPolicy(harness, vault),
          }),
        );
        expect(outcome).toEqual({ callId: 'c1', kind: 'result', result: { status: 'failed', output: `Permission denied: ${target} is blocked by the sandbox policy`, denial: { source: 'sandbox', reason: `${target} is blocked by the sandbox policy` } } });
        expect(runs).toEqual([]);
      });
    }
  }

  it('denies the readDenied entry itself', async () => {
    const harness = makeHarness();
    const vault = path.join(harness.layout.project, 'vault');
    fs.mkdirSync(vault);
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(pathTool('read', vault, runs)), [call('c1', 'PathTool')], { sandboxPolicy: deniedPolicy(harness, vault) }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed', output: `Permission denied: ${vault} is blocked by the sandbox policy` } });
  });

  it('does not deny a sibling sharing the name prefix', async () => {
    const harness = makeHarness();
    const vault = path.join(harness.layout.project, 'vault');
    const sibling = path.join(harness.layout.project, 'vault-public', 'a.txt');
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(pathTool('read', sibling, runs)), [call('c1', 'PathTool')], { sandboxPolicy: deniedPolicy(harness, vault) }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(runs).toEqual([sibling]);
  });

  it('denies a path that reaches readDenied through a symlink', async () => {
    const harness = makeHarness();
    const vault = path.join(harness.layout.home, '.momonga');
    fs.mkdirSync(vault);
    fs.writeFileSync(path.join(vault, 'token'), 'x');
    const link = path.join(harness.layout.project, 'innocent');
    fs.symlinkSync(vault, link);
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(pathTool('read', path.join(link, 'token'), runs)), [call('c1', 'PathTool', {}, 'allow_once')], {
        mode: 'bypassPermissions',
        sandboxPolicy: deniedPolicy(harness, vault),
      }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect((outcome as { result: { output: string } }).result.output).toMatch(/^Permission denied: .* is blocked by the sandbox policy$/);
    expect(runs).toEqual([]);
  });

  it('leaves command subjects to the sandbox', async () => {
    const harness = makeHarness();
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(execTool(runs)), [call('c1', 'Bash')], {
        mode: 'bypassPermissions',
        sandboxPolicy: deniedPolicy(harness, harness.layout.project),
      }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
  });
});

describe('executor: sandbox kind none', () => {
  it('turns an allowed exec call into ask without a suggested rule', async () => {
    const harness = makeHarness();
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(execTool(runs)), [call('c1', 'Bash')], { mode: 'bypassPermissions', sandbox: noneSandbox }),
    );
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'needs_approval', decision: { kind: 'ask' }, title: 'Bash title', toolKind: 'execute' });
    expect(outcome !== undefined && 'suggestedRule' in outcome).toBe(false);
    expect(runs).toEqual([]);
  });

  it('turns an exec call allowed by a rule into ask', async () => {
    const harness = makeHarness();
    const runs: string[] = [];
    const rule = ruleFor(harness.layout)('allow', 'Bash(echo:*)');
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(execTool(runs)), [call('c1', 'Bash')], { rules: [rule], sandbox: noneSandbox }),
    );
    expect(outcome).toMatchObject({ kind: 'needs_approval', decision: { kind: 'ask' } });
    expect(outcome !== undefined && 'suggestedRule' in outcome).toBe(false);
  });

  it('keeps a deny decision as deny', async () => {
    const harness = makeHarness();
    const runs: string[] = [];
    const rule = ruleFor(harness.layout)('deny', 'Bash(echo:*)');
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(execTool(runs)), [call('c1', 'Bash')], { mode: 'bypassPermissions', rules: [rule], sandbox: noneSandbox }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect((outcome as { result: { output: string } }).result.output).toMatch(/^Permission denied: /);
    expect(runs).toEqual([]);
  });

  it('runs the call once it carries an approval', async () => {
    const harness = makeHarness();
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(execTool(runs)), [call('c1', 'Bash', {}, 'allow_once')], { mode: 'bypassPermissions', sandbox: noneSandbox }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'ran' } });
    expect(runs).toEqual(['ran']);
  });

  it('does not affect non-exec tools', async () => {
    const harness = makeHarness();
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(execTool(runs, 'read_only')), [call('c1', 'Bash')], { mode: 'bypassPermissions', sandbox: noneSandbox }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
  });

  it('lets an allowed exec call run under a seatbelt sandbox', async () => {
    const harness = makeHarness();
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(execTool(runs)), [call('c1', 'Bash')], { mode: 'bypassPermissions' }));
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(runs).toEqual(['ran']);
  });
});
