import { describe, expect, it } from 'vitest';
import type { AutoClassifier, AutoClassifierRequest, PreToolHookVerdict, ToolHooks } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { ruleFor } from './helpers.ts';

const BASH = { kind: 'execute' as const, sideEffect: 'exec' as const };
const subject = { kind: 'command' as const, tool: 'Bash', command: 'make build' };

const fakeHooks = (verdict: PreToolHookVerdict | undefined, post: string | undefined = undefined) => {
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
    const { hooks } = fakeHooks({ decision: 'allow', reason: undefined });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(bash(executed)), [call('c1', 'Bash')], { hooks }));
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'built' } });
    expect(executed).toEqual(['run']);
  });

  it('keeps an ask rule asking when a hook allows', async () => {
    const harness = makeHarness();
    const executed: string[] = [];
    const { hooks } = fakeHooks({ decision: 'allow', reason: undefined });
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
    const { hooks, seen } = fakeHooks(undefined, 'lint failed');
    const rules = [ruleFor(harness.layout)('allow', 'Bash(make build)')];
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(bash(executed)), [call('c1', 'Bash')], { hooks, rules }));
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'built\n\n[PostToolUse hook]\nlint failed' } });
    expect(seen).toEqual(['pre:c1', 'post:c1:built']);
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
