import { describe, expect, it } from 'vitest';
import type { AutoClassifier, AutoClassifierRequest, PostToolHookResult, PreToolHookVerdict, ToolHooks } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { policyFor, ruleFor, sessionTmpDirOf } from './helpers.ts';

const BASH = { kind: 'execute' as const, sideEffect: 'exec' as const };
const subject = { kind: 'command' as const, tool: 'Bash', command: 'make build' };

const fakeHooks = (verdict: PreToolHookVerdict | undefined, post: PostToolHookResult | undefined = undefined) => {
  const seen: string[] = [];
  const hooks: ToolHooks = {
    matchesPreToolUse: () => true,
    preToolUse: async ({ callId }) => {
      seen.push(`pre:${callId}`);
      return verdict;
    },
    postToolUse: async ({ callId, output }) => {
      seen.push(`post:${callId}:${output}`);
      return post;
    },
  };
  return { hooks, seen };
};

const fakeClassifier = (answer: 'allow' | 'ask') => {
  const requests: AutoClassifierRequest[] = [];
  const classifier: AutoClassifier = {
    classify: async (request) => {
      requests.push(request);
      return answer;
    },
  };
  return { classifier, requests };
};

const bash = (executed: string[]) =>
  makeTool('Bash', {
    ...BASH,
    subject: () => subject,
    execute: async () => {
      executed.push('run');
      return { status: 'completed' as const, output: 'built' };
    },
  });

describe('PreToolUse hooks in the permission gate', () => {
  it('denies with a structured hook denial and never runs the tool', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { hooks } = fakeHooks({ decision: 'deny', reason: 'no builds today' });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(bash(executed)), [call('c1', 'Bash')], { hooks, mode: 'bypassPermissions' }));
    expect(outcome).toEqual({
      callId: 'c1',
      kind: 'result',
      result: { status: 'failed', output: 'Permission denied: no builds today', denial: { source: 'hook', reason: 'no builds today' } },
    });
    expect(executed).toEqual([]);
  });

  it('cannot override a deny rule with a hook allow, and does not even run the hook', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { hooks, seen } = fakeHooks({ decision: 'allow', reason: 'fine' });
    const rules = [ruleFor(harness.layout)('deny', 'Bash(make build)')];
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(bash(executed)), [call('c1', 'Bash')], { hooks, rules }));
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed', denial: { source: 'rule' } } });
    expect(executed).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('lets a hook allow resolve a mode default ask', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { hooks } = fakeHooks({ decision: 'allow' });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(bash(executed)), [call('c1', 'Bash')], { hooks }));
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'built' } });
    expect(executed).toEqual(['run']);
  });

  it('keeps an ask rule asking when a hook allows', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { hooks } = fakeHooks({ decision: 'allow' });
    const rules = [ruleFor(harness.layout)('ask', 'Bash(make build)')];
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(bash(executed)), [call('c1', 'Bash')], { hooks, rules }));
    expect(outcome).toMatchObject({ kind: 'needs_approval', decision: { source: 'rule' } });
    expect(executed).toEqual([]);
  });

  it('narrows an allow rule into an approval request when a hook asks, with no suggested rule', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { hooks } = fakeHooks({ decision: 'ask', reason: 'confirm builds' });
    const rules = [ruleFor(harness.layout)('allow', 'Bash(make build)')];
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(bash(executed)), [call('c1', 'Bash')], { hooks, rules }));
    expect(outcome).toMatchObject({ kind: 'needs_approval', decision: { source: 'hook', reason: 'confirm builds' } });
    expect(outcome).not.toHaveProperty('suggestedRule');
    expect(executed).toEqual([]);
  });

  it('appends PostToolUse feedback to a completed result', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { hooks, seen } = fakeHooks(undefined, { feedback: 'lint failed' });
    const rules = [ruleFor(harness.layout)('allow', 'Bash(make build)')];
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(bash(executed)), [call('c1', 'Bash')], { hooks, rules }));
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'built\n\n[PostToolUse hook]\nlint failed' } });
    expect(seen).toEqual(['pre:c1', 'post:c1:built']);
  });
});

describe('questions only a person may answer: protected writes and removal of the workspace', () => {
  const commandTool = (command: string, executed: string[]) =>
    makeTool('Bash', {
      ...BASH,
      subject: () => ({ kind: 'command' as const, tool: 'Bash', command }),
      execute: async () => {
        executed.push('run');
        return { status: 'completed' as const, output: 'done' };
      },
    });

  it.each([
    ['removal of the workspace', 'rm -rf .'],
    ['a protected write', 'touch .envrc'],
  ])('never sends %s to the auto classifier', async (_label, command) => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { classifier, requests } = fakeClassifier('allow');
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(commandTool(command, executed)), [call('c1', 'Bash')], { mode: 'auto', classifier, tmpDir: sessionTmpDirOf(harness.layout), sandboxPolicy: policyFor({ layout: harness.layout }) }));
    expect(outcome).toMatchObject({ kind: 'needs_approval' });
    expect(requests).toEqual([]);
    expect(executed).toEqual([]);
  });

  it.each([
    ['removal of the workspace', 'rm -rf .'],
    ['a protected write', 'touch .envrc'],
  ])('is not resolved by a hook allow for %s', async (_label, command) => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { hooks } = fakeHooks({ decision: 'allow', reason: 'fine' });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(commandTool(command, executed)), [call('c1', 'Bash')], { hooks, tmpDir: sessionTmpDirOf(harness.layout), sandboxPolicy: policyFor({ layout: harness.layout }) }));
    expect(outcome).toMatchObject({ kind: 'needs_approval' });
    expect(executed).toEqual([]);
  });

  it('still lets a hook allow resolve an ordinary mode ask', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { hooks } = fakeHooks({ decision: 'allow', reason: 'fine' });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(commandTool('make build', executed)), [call('c1', 'Bash')], { hooks }));
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
  });
});

describe('auto mode classifier in the permission gate', () => {
  it('runs an allowed call without an approval when the classifier allows', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { classifier, requests } = fakeClassifier('allow');
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(bash(executed)), [call('c1', 'Bash')], { mode: 'auto', classifier }));
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ callId: 'c1', toolName: 'Bash', reason: expect.stringContaining('approval') });
  });

  it('turns the call into an approval request when the classifier does not allow', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { classifier } = fakeClassifier('ask');
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(bash(executed)), [call('c1', 'Bash')], { mode: 'auto', classifier }));
    expect(outcome).toMatchObject({ kind: 'needs_approval' });
    expect(executed).toEqual([]);
  });

  it('never consults the classifier for a deny rule or an explicit ask rule', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { classifier, requests } = fakeClassifier('allow');
    const denyRules = [ruleFor(harness.layout)('deny', 'Bash(make build)')];
    const [denied] = await harness.executor.runBatch(harness.input(await toolSetOf(bash(executed)), [call('c1', 'Bash')], { mode: 'auto', classifier, rules: denyRules }));
    expect(denied).toMatchObject({ kind: 'result', result: { denial: { source: 'rule' } } });
    const askRules = [ruleFor(harness.layout)('ask', 'Bash(make build)')];
    const [asked] = await harness.executor.runBatch(harness.input(await toolSetOf(bash(executed)), [call('c2', 'Bash')], { mode: 'auto', classifier, rules: askRules }));
    expect(asked).toMatchObject({ kind: 'needs_approval' });
    expect(requests).toEqual([]);
    expect(executed).toEqual([]);
  });

  it('does not consult the classifier again once the person approved the call', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { classifier, requests } = fakeClassifier('ask');
    const set = await toolSetOf(bash(executed));
    const [first] = await harness.executor.runBatch(harness.input(set, [call('c1', 'Bash')], { mode: 'auto', classifier }));
    expect(first?.kind).toBe('needs_approval');
    const digest = (first as { subjectDigest: string }).subjectDigest;
    const [second] = await harness.executor.runBatch(
      harness.input(set, [{ ...call('c1', 'Bash'), approval: { kind: 'allow_once', subjectDigest: digest } }], { mode: 'auto', classifier }),
    );
    expect(second).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(requests).toHaveLength(1);
  });

  it('does not run a classifier or a hook while previewing calls queued behind an approval', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { classifier, requests } = fakeClassifier('allow');
    const { hooks, seen } = fakeHooks(undefined);
    const rules = [ruleFor(harness.layout)('ask', 'Bash(make build)')];
    const outcomes = await harness.executor.runBatch(
      harness.input(await toolSetOf(bash(executed)), [call('c1', 'Bash'), call('c2', 'Bash')], { mode: 'auto', classifier, hooks, rules }),
    );
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['needs_approval', 'deferred']);
    expect(requests).toEqual([]);
    expect(seen).toEqual(['pre:c1']);
  });

  it('refuses to run auto mode without a classifier', async () => {
    const harness = makeHarness();
    await expect(harness.executor.runBatch(harness.input(await toolSetOf(bash([])), [call('c1', 'Bash')], { mode: 'auto' }))).rejects.toThrow(/classifier/);
  });
});

describe('PreToolUse hook input updates, halting and single execution', () => {
  const COMMAND_SCHEMA = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } as const;
  const inputBash = (executed: unknown[]) =>
    makeTool('Bash', {
      ...BASH,
      inputSchema: COMMAND_SCHEMA,
      title: (input: unknown) => String((input as { command?: unknown }).command),
      subject: (input: unknown) => ({ kind: 'command' as const, tool: 'Bash', command: String((input as { command?: unknown }).command) }),
      execute: async (input: unknown) => {
        executed.push(input);
        return { status: 'completed' as const, output: 'ran' };
      },
    });
  const countingHooks = (verdict: PreToolHookVerdict | undefined) => {
    let runs = 0;
    const hooks: ToolHooks = {
      matchesPreToolUse: () => true,
      preToolUse: async () => {
        runs += 1;
        return verdict;
      },
      postToolUse: async () => undefined,
    };
    return { hooks, runs: () => runs };
  };

  it('executes the updated input and re-evaluates policy against it', async () => {
    const harness = makeHarness();
    const executed: unknown[] = [];
    const { hooks } = countingHooks({ decision: 'allow', updatedInput: { command: 'make safe' } });
    const rules = [ruleFor(harness.layout)('allow', 'Bash(make safe)')];
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(inputBash(executed)), [{ ...call('c1', 'Bash'), arguments: { command: 'make build' } }], { hooks, rules }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(executed).toEqual([{ command: 'make safe' }]);
  });

  it('denies an updated input that a deny rule covers even when the original was allowed', async () => {
    const harness = makeHarness();
    const executed: unknown[] = [];
    const { hooks } = countingHooks({ decision: 'allow', updatedInput: { command: 'make danger' } });
    const rules = [ruleFor(harness.layout)('allow', 'Bash(make build)'), ruleFor(harness.layout)('deny', 'Bash(make danger)')];
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(inputBash(executed)), [{ ...call('c1', 'Bash'), arguments: { command: 'make build' } }], { hooks, rules }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { denial: { source: 'rule' } } });
    expect(executed).toEqual([]);
  });

  it('rejects an updated input that fails the tool schema', async () => {
    const harness = makeHarness();
    const executed: unknown[] = [];
    const { hooks } = countingHooks({ decision: 'allow', updatedInput: { command: 5 } });
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(inputBash(executed)), [{ ...call('c1', 'Bash'), arguments: { command: 'make build' } }], { hooks }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed', output: expect.stringContaining('rejects') } });
    expect(executed).toEqual([]);
  });

  it('runs the PreToolUse hooks once for a call that needs approval and reuses the updated input after it', async () => {
    const harness = makeHarness();
    const executed: unknown[] = [];
    const { hooks, runs } = countingHooks({ updatedInput: { command: 'make safe' } });
    const set = await toolSetOf(inputBash(executed));
    const first = { ...call('c1', 'Bash'), arguments: { command: 'make build' } };
    const [asked] = await harness.executor.runBatch(harness.input(set, [first], { hooks }));
    expect(asked).toMatchObject({ kind: 'needs_approval', title: 'make safe' });
    const digest = (asked as { subjectDigest: string }).subjectDigest;
    const [done] = await harness.executor.runBatch(harness.input(set, [{ ...first, approval: { kind: 'allow_once' as const, subjectDigest: digest } }], { hooks }));
    expect(done).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(executed).toEqual([{ command: 'make safe' }]);
    expect(runs()).toBe(1);
  });

  it('stops the remaining calls of the batch and reports the reason when a hook halts', async () => {
    const harness = makeHarness();
    const executed: unknown[] = [];
    const halts: string[] = [];
    const { hooks } = countingHooks({ halt: { reason: 'maintenance window' } });
    const outcomes = await harness.executor.runBatch(
      harness.input(await toolSetOf(inputBash(executed)), [{ ...call('c1', 'Bash'), arguments: { command: 'a' } }, { ...call('c2', 'Bash'), arguments: { command: 'b' } }], {
        hooks,
        mode: 'bypassPermissions',
        onHalt: (reason: string) => void halts.push(reason),
      }),
    );
    expect(outcomes.map((outcome) => (outcome as { result: { status: string } }).result.status)).toEqual(['failed', 'failed']);
    expect(executed).toEqual([]);
    expect(halts).toEqual(['maintenance window']);
  });

  it('halts the batch after a PostToolUse hook asks to stop', async () => {
    const harness = makeHarness();
    const executed: unknown[] = [];
    const halts: string[] = [];
    const hooks: ToolHooks = {
      matchesPreToolUse: () => false,
      preToolUse: async () => undefined,
      postToolUse: async () => ({ halt: { reason: 'enough' } }),
    };
    const outcomes = await harness.executor.runBatch(
      harness.input(await toolSetOf(inputBash(executed)), [{ ...call('c1', 'Bash'), arguments: { command: 'a' } }, { ...call('c2', 'Bash'), arguments: { command: 'b' } }], {
        hooks,
        mode: 'bypassPermissions',
        onHalt: (reason: string) => void halts.push(reason),
      }),
    );
    expect(executed).toEqual([{ command: 'a' }]);
    expect(outcomes[0]).toMatchObject({ result: { status: 'completed' } });
    expect(outcomes[1]).toMatchObject({ result: { status: 'failed' } });
    expect(halts).toEqual(['enough']);
  });
});
