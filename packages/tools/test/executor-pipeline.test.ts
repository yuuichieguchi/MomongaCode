import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { decide, suggestAllowRule } from '@momonga/policy';
import { ToolExecutionError, ToolInputError } from '@momonga/tools';
import type { ToolContext } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { keyFor, ruleFor } from './helpers.ts';

const counting = () => {
  const calls: string[] = [];
  return {
    calls,
    execute: async () => {
      calls.push('execute');
      return { status: 'completed' as const, output: 'done' };
    },
  };
};

const BASH = { kind: 'execute' as const, sideEffect: 'exec' as const };

describe('executor pipeline early exits', () => {
  it('fails an unknown tool listing available tools, without a record', async () => {
    const harness = makeHarness();
    const set = await toolSetOf(makeTool('Read'), makeTool('Write', { kind: 'edit', sideEffect: 'write' }));
    const outcomes = await harness.executor.runBatch(harness.input(set, [call('c1', 'Nope')]));
    expect(outcomes).toEqual([
      { callId: 'c1', kind: 'result', result: { status: 'failed', output: 'Unknown tool "Nope". Available tools: Read, Write' } },
    ]);
    expect(harness.idempotency.records.size).toBe(0);
    expect(harness.started).toEqual([]);
  });

  it('fails when subject throws ToolInputError, without a record', async () => {
    const harness = makeHarness();
    const probe = counting();
    const tool = makeTool('Read', {
      subject: () => {
        throw new ToolInputError('file_path must be absolute');
      },
      execute: probe.execute,
    });
    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Read')]));
    expect(outcomes).toEqual([{ callId: 'c1', kind: 'result', result: { status: 'failed', output: 'file_path must be absolute' } }]);
    expect(probe.calls).toEqual([]);
    expect(harness.idempotency.records.size).toBe(0);
  });

  it('fails a denied call with the decision reason, without a record', async () => {
    const harness = makeHarness();
    const probe = counting();
    const subject = { kind: 'command' as const, tool: 'Bash', command: 'make build' };
    const tool = makeTool('Bash', { ...BASH, subject: () => subject, execute: probe.execute });
    const rules = [ruleFor(harness.layout)('deny', 'Bash')];
    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash')], { rules }));
    const expected = decide({
      tool: { name: 'Bash', ...BASH },
      subject,
      mode: 'default',
      rules,
      roots: [harness.layout.project],
      home: harness.layout.home,
      cwd: harness.layout.project,
      protectedPaths: [],
    });
    expect(expected.kind).toBe('deny');
    expect(outcomes).toEqual([{ callId: 'c1', kind: 'result', result: { status: 'failed', output: `Permission denied: ${expected.reason}` } }]);
    expect(probe.calls).toEqual([]);
    expect(harness.idempotency.records.size).toBe(0);
  });

  it('returns needs_approval for ask with decision, suggested rule, title, kind and locations', async () => {
    const harness = makeHarness();
    const probe = counting();
    const subject = { kind: 'command' as const, tool: 'Bash', command: 'make build' };
    const tool = makeTool('Bash', {
      ...BASH,
      subject: () => subject,
      title: (input) => `Run ${String(input['value'])}`,
      locations: () => [{ path: '/work/Makefile', line: 3 }],
      execute: probe.execute,
    });
    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash', { value: 'make' })]));
    const decision = decide({
      tool: { name: 'Bash', ...BASH },
      subject,
      mode: 'default',
      rules: [],
      roots: [harness.layout.project],
      home: harness.layout.home,
      cwd: harness.layout.project,
      protectedPaths: [],
    });
    expect(outcomes).toEqual([
      {
        callId: 'c1',
        kind: 'needs_approval',
        decision,
        suggestedRule: 'Bash(make build)',
        title: 'Run make',
        toolKind: 'execute',
        locations: [{ path: '/work/Makefile', line: 3 }],
        subjectDigest: sha256Hex(canonicalJson({ subject, cwd: harness.layout.project })),
      },
    ]);
    expect(suggestAllowRule({ name: 'Bash', ...BASH }, subject, { cwd: harness.layout.project, home: harness.layout.home })).toBe('Bash(make build)');
    expect(probe.calls).toEqual([]);
    expect(harness.idempotency.records.size).toBe(0);
  });

  it('asks again when the same command is resent with an approval bound to a different cwd', async () => {
    const harness = makeHarness();
    const probe = counting();
    const dirA = path.join(harness.layout.project, 'a');
    const dirB = path.join(harness.layout.project, 'b');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    const tool = makeTool('Bash', { ...BASH, subject: () => ({ kind: 'command', tool: 'Bash', command: 'rm -r tmp' }), execute: probe.execute });
    const toolSet = await toolSetOf(tool);
    harness.session.cwd = dirA;
    const [first] = await harness.executor.runBatch(harness.input(toolSet, [call('c1', 'Bash')]));
    if (first?.kind !== 'needs_approval') throw new Error('expected needs_approval');
    harness.session.cwd = dirB;
    const [again] = await harness.executor.runBatch(
      harness.input(toolSet, [call('c1', 'Bash', {}, { kind: 'allow_once', subjectDigest: first.subjectDigest })]),
    );
    expect(again?.kind).toBe('needs_approval');
    if (again?.kind !== 'needs_approval') throw new Error('expected needs_approval');
    expect(again.subjectDigest).not.toBe(first.subjectDigest);
    expect(probe.calls).toEqual([]);
  });

  const withUnresolvableCwd = async (run: (cwd: string) => Promise<void>): Promise<void> => {
    const harness = makeHarness();
    const locked = path.join(harness.layout.project, 'locked');
    const cwd = path.join(locked, 'cwd');
    fs.mkdirSync(cwd, { recursive: true });
    fs.chmodSync(locked, 0o000);
    try {
      await run(cwd);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  };

  it('fails only the command call when the session cwd cannot be canonicalized for its digest', async () => {
    const harness = makeHarness();
    const locked = path.join(harness.layout.project, 'locked');
    const cwd = path.join(locked, 'cwd');
    fs.mkdirSync(cwd, { recursive: true });
    const probe = counting();
    const reader = makeTool('Read', { execute: async () => ({ status: 'completed', output: 'read ok' }) });
    const bash = makeTool('Bash', { ...BASH, subject: () => ({ kind: 'command', tool: 'Bash', command: 'rm -r tmp' }), execute: probe.execute });
    const toolSet = await toolSetOf(reader, bash);
    harness.session.cwd = cwd;
    fs.chmodSync(locked, 0o000);
    try {
      const outcomes = await harness.executor.runBatch(harness.input(toolSet, [call('r1', 'Read'), call('b1', 'Bash')]));
      expect(outcomes.map((outcome) => outcome.callId)).toEqual(['r1', 'b1']);
      expect(outcomes[0]).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'read ok' } });
      expect(outcomes[1]?.kind).toBe('result');
      if (outcomes[1]?.kind !== 'result') throw new Error('expected result');
      expect(outcomes[1].result.status).toBe('failed');
      expect(outcomes[1].result.output.startsWith('Permission check failed: session cwd')).toBe(true);
      expect(probe.calls).toEqual([]);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('runs an allowed sandboxed command call without needing the cwd digest', async () => {
    await withUnresolvableCwd(async (cwd) => {
      const harness = makeHarness();
      const probe = counting();
      const bash = makeTool('Bash', { ...BASH, subject: () => ({ kind: 'command', tool: 'Bash', command: 'make build' }), execute: probe.execute });
      harness.session.cwd = cwd;
      const [outcome] = await harness.executor.runBatch(
        harness.input(await toolSetOf(bash), [call('b1', 'Bash')], { rules: [ruleFor(harness.layout)('allow', 'Bash(make build)')] }),
      );
      expect(outcome).toMatchObject({ callId: 'b1', kind: 'result', result: { status: 'completed', output: 'done' } });
      expect(probe.calls).toEqual(['execute']);
    });
  });

  it('omits the suggested rule when the ask comes from a protected path', async () => {
    const harness = makeHarness();
    const target = path.join(harness.layout.project, '.git', 'config');
    fs.mkdirSync(path.dirname(target));
    const tool = makeTool('Write', {
      kind: 'edit',
      sideEffect: 'write',
      subject: () => ({ kind: 'path', tool: 'Write', paths: [target], access: 'write' }),
    });
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Write')], {
        mode: 'bypassPermissions',
        protectedPaths: [path.join(harness.layout.project, '.git')],
      }),
    );
    expect(outcome?.kind).toBe('needs_approval');
    if (outcome?.kind !== 'needs_approval') throw new Error('expected needs_approval');
    expect(outcome.decision.source).toBe('protected');
    expect(outcome.suggestedRule).toBeUndefined();
  });

  it('proceeds on ask when the call carries an approval', async () => {
    const harness = makeHarness();
    const probe = counting();
    const tool = makeTool('Bash', { ...BASH, subject: () => ({ kind: 'command', tool: 'Bash', command: 'make build' }), execute: probe.execute });
    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash', {}, 'allow_once')]));
    expect(outcomes[0]).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'completed', output: 'done' } });
    expect(probe.calls).toEqual(['execute']);
  });

  it('still fails a denied call that carries an approval', async () => {
    const harness = makeHarness();
    const probe = counting();
    const tool = makeTool('Bash', { ...BASH, subject: () => ({ kind: 'command', tool: 'Bash', command: 'make build' }), execute: probe.execute });
    const rules = [ruleFor(harness.layout)('deny', 'Bash')];
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash', {}, 'allow_always')], { rules }));
    if (outcome?.kind !== 'result') throw new Error('expected result');
    expect(outcome.result.output.startsWith('Permission denied: ')).toBe(true);
    expect(probe.calls).toEqual([]);
  });

  it.each([0, -1])('fails when the deadline has passed (offset %i), without a record', async (offset) => {
    const harness = makeHarness();
    const probe = counting();
    const set = await toolSetOf(makeTool('Read', { execute: probe.execute }));
    const outcomes = await harness.executor.runBatch(harness.input(set, [call('c1', 'Read')], { deadlineAt: harness.clock.now() + offset }));
    expect(outcomes).toEqual([
      { callId: 'c1', kind: 'result', result: { status: 'failed', output: 'Run deadline exceeded before Read could start' } },
    ]);
    expect(probe.calls).toEqual([]);
    expect(harness.idempotency.records.size).toBe(0);
  });

  it.each([
    ['ToolInputError', () => new ToolInputError('old_string not found')],
    ['ToolExecutionError', () => new ToolExecutionError('file changed since read')],
  ])('fails when prepare throws %s, without a record', async (_label, makeError) => {
    const harness = makeHarness();
    const probe = counting();
    const error = makeError();
    const tool = makeTool('Edit', {
      kind: 'edit',
      sideEffect: 'write',
      prepare: async () => {
        throw error;
      },
      execute: probe.execute,
    });
    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Edit')]));
    expect(outcomes).toEqual([{ callId: 'c1', kind: 'result', result: { status: 'failed', output: error.message } }]);
    expect(probe.calls).toEqual([]);
    expect(harness.idempotency.records.size).toBe(0);
    expect(harness.started).toEqual([]);
  });

  it('validates before deciding and decides before checking the deadline', async () => {
    const harness = makeHarness();
    const subjects: string[] = [];
    const tool = makeTool('Bash', {
      ...BASH,
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      subject: () => {
        subjects.push('subject');
        return { kind: 'command', tool: 'Bash', command: 'make build' };
      },
    });
    const set = await toolSetOf(tool);
    const deadlineAt = harness.clock.now();
    const [invalid] = await harness.executor.runBatch(harness.input(set, [call('c1', 'Bash', {})], { deadlineAt }));
    expect(invalid).toMatchObject({ kind: 'result', result: { status: 'failed', output: 'Invalid input for Bash:\n- value: required property is missing' } });
    expect(subjects).toEqual([]);
    const [asked] = await harness.executor.runBatch(harness.input(set, [call('c2', 'Bash', { value: 'x' })], { deadlineAt }));
    expect(asked?.kind).toBe('needs_approval');
  });
});

describe('executor execution', () => {
  it('passes prepared data to execute and stores it in the idempotency meta', async () => {
    const harness = makeHarness({ idempotencyTtlMs: 5000 });
    const seen: unknown[] = [];
    const tool = makeTool('Edit', {
      kind: 'edit',
      sideEffect: 'write',
      prepare: async () => ({ before: 'abc' }),
      execute: async (_input, _ctx, prepared) => {
        seen.push(prepared);
        return { status: 'completed', output: 'edited' };
      },
    });
    await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Edit')]));
    expect(seen).toEqual([{ before: 'abc' }]);
    const begin = harness.idempotency.log.find((entry) => entry.op === 'begin');
    expect(begin).toEqual({
      op: 'begin',
      key: keyFor('run-1', 1, 'c1'),
      expiresAt: harness.clock.now() + 5000,
      meta: { tool: 'Edit', prepared: { before: 'abc' } },
      s: 'NEW',
    });
  });

  it('exposes the idempotency key as ctx.idemKey in prepare and execute', async () => {
    const harness = makeHarness();
    const seen: Array<[string, string]> = [];
    const tool = makeTool('Edit', {
      kind: 'edit',
      sideEffect: 'write',
      prepare: async (_input, ctx) => {
        seen.push(['prepare', ctx.idemKey]);
        return {};
      },
      execute: async (_input, ctx) => {
        seen.push(['execute', ctx.idemKey]);
        return { status: 'completed', output: 'edited' };
      },
    });
    await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c9', 'Edit')], { runId: 'run-k', step: 3 }));
    const expected = sha256Hex(canonicalJson(['run-k', 3, 'c9']));
    const begin = harness.idempotency.log.find((entry) => entry.op === 'begin');
    expect(begin?.key).toBe(expected);
    expect(seen).toEqual([
      ['prepare', expected],
      ['execute', expected],
    ]);
  });

  it('defaults the idempotency TTL to seven days', async () => {
    const harness = makeHarness();
    await harness.executor.runBatch(harness.input(await toolSetOf(makeTool('Read')), [call('c1', 'Read')]));
    const begin = harness.idempotency.log.find((entry) => entry.op === 'begin');
    expect(begin?.op === 'begin' ? begin.expiresAt : undefined).toBe(harness.clock.now() + 7 * 24 * 60 * 60 * 1000);
  });

  it('builds the tool context from the batch input', async () => {
    const harness = makeHarness();
    const contexts: ToolContext[] = [];
    const tool = makeTool('Read', {
      execute: async (_input, ctx) => {
        contexts.push(ctx);
        return { status: 'completed', output: 'ok' };
      },
    });
    const batch = harness.input(await toolSetOf(tool), [call('c7', 'Read')], { step: 4 });
    await harness.executor.runBatch(batch);
    const ctx = contexts[0];
    expect(ctx).toBeDefined();
    if (ctx === undefined) return;
    expect(ctx.runId).toBe('run-1');
    expect(ctx.step).toBe(4);
    expect(ctx.callId).toBe('c7');
    expect(ctx.cwd).toBe(harness.layout.project);
    expect(ctx.home).toBe(harness.layout.home);
    expect(ctx.roots).toEqual([harness.layout.project]);
    expect(ctx.env).toEqual({ LANG: 'C' });
    expect(ctx.deadlineAt).toBe(batch.deadlineAt);
    expect(ctx.session).toBe(harness.session);
    expect(ctx.sandbox).toBe(batch.sandbox);
    expect(ctx.sandboxPolicy).toBe(batch.sandboxPolicy);
    expect(ctx.blobs).toBe(harness.blobs.port);
    expect(ctx.clock.now()).toBe(harness.clock.now());
    expect(ctx.signal.aborted).toBe(false);
  });

  it('records the result and returns completed output', async () => {
    const harness = makeHarness();
    const set = await toolSetOf(makeTool('Read', { execute: async () => ({ status: 'completed', output: 'contents', plan: [] }) }));
    const outcomes = await harness.executor.runBatch(harness.input(set, [call('c1', 'Read')]));
    const key = keyFor('run-1', 1, 'c1');
    expect(outcomes).toEqual([{ callId: 'c1', kind: 'result', result: { status: 'completed', output: 'contents', plan: [] }, idemKey: key }]);
    expect(harness.idempotency.stateOf(key)).toBe('COMPLETED');
  });

  it('awaits onStarted with the idempotency key before execute', async () => {
    const harness = makeHarness();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = makeTool('Write', {
      kind: 'edit',
      sideEffect: 'write',
      execute: async () => {
        order.push('execute');
        return { status: 'completed', output: 'w' };
      },
    });
    const running = harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Write')], {
        onStarted: async (callId, key) => {
          order.push(`started:${callId}:${key}`);
          await gate;
          order.push('released');
        },
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual([`started:c1:${keyFor('run-1', 1, 'c1')}`]);
    release();
    await running;
    expect(order).toEqual([`started:c1:${keyFor('run-1', 1, 'c1')}`, 'released', 'execute']);
  });

  it.each([
    ['ToolInputError', () => new ToolInputError('bad offset'), 'bad offset'],
    ['ToolExecutionError', () => new ToolExecutionError('permission denied by filesystem'), 'permission denied by filesystem'],
  ])('fails with the message of a thrown %s', async (_label, makeError, message) => {
    const harness = makeHarness();
    const tool = makeTool('Read', {
      execute: async () => {
        throw makeError();
      },
    });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Read')]));
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'failed', output: message } });
    expect(harness.idempotency.stateOf(keyFor('run-1', 1, 'c1'))).toBe('COMPLETED');
  });

  it('reports other thrown values as internal errors without a stack', async () => {
    const harness = makeHarness();
    const tool = makeTool('Read', {
      execute: async () => {
        throw new TypeError('boom happened');
      },
    });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Read')]));
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed', output: 'Internal error in Read: boom happened' } });
  });

  it('forwards ctx.attachProcess to the idempotency port under the call key', async () => {
    const harness = makeHarness();
    const tool = makeTool('Bash', {
      ...BASH,
      execute: async (_input, ctx) => {
        ctx.attachProcess({ pgid: 4242, startedAt: 1_234_567 });
        return { status: 'completed', output: 'ran' };
      },
    });
    await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash', {}, 'allow_once')]));
    expect(harness.idempotency.log.filter((entry) => entry.op === 'attachProcess')).toEqual([
      { op: 'attachProcess', key: keyFor('run-1', 1, 'c1'), pgid: 4242, startedAt: 1_234_567 },
    ]);
  });

  it('forwards ctx.update to onUpdate with the call id', async () => {
    const harness = makeHarness();
    const updates: unknown[] = [];
    const content = [{ type: 'content' as const, content: { type: 'text' as const, text: 'progress' } }];
    const tool = makeTool('Read', {
      execute: async (_input, ctx) => {
        ctx.update(content);
        return { status: 'completed', output: 'ok' };
      },
    });
    await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c3', 'Read')], { onUpdate: (callId, update) => void updates.push([callId, update]) }),
    );
    expect(updates).toEqual([['c3', content]]);
  });
});
