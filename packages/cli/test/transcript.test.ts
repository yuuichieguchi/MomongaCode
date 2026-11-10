import { describe, expect, it } from 'vitest';
import type { PublicRunEvent } from '@momonga/protocol';
import { initialTranscript, nextMode, reduceChildEvent, reduceEvent, settledCount } from '../src/tui/transcript.ts';
import type { Transcript } from '../src/tui/transcript.ts';

const envelope = { id: 1, runId: 'r', sessionId: 's', seq: 1, step: 1, createdAt: 1 } as const;

const apply = (events: readonly Record<string, unknown>[]): Transcript =>
  events.reduce<Transcript>((state, event) => reduceEvent(state, { ...envelope, ...event } as PublicRunEvent), initialTranscript);

const call = { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Read', kind: 'read', title: 'Read /a', rawInput: {} };

describe('reduceEvent', () => {
  it('appends message deltas of one item and starts a new entry for the next item', () => {
    const state = apply([
      { type: 'agent.message.delta', attempt: 0, itemId: 'a', text: 'Hel' },
      { type: 'agent.message.delta', attempt: 0, itemId: 'a', text: 'lo' },
      { type: 'agent.message.delta', attempt: 0, itemId: 'b', text: 'again' },
    ]);
    expect(state.entries).toEqual([
      { kind: 'assistant', itemId: 'a', text: 'Hello', open: false },
      { kind: 'assistant', itemId: 'b', text: 'again', open: true },
    ]);
  });

  it('follows a tool call from requested to running to completed', () => {
    const states = [call, { type: 'tool.started', callId: 'c1', idemKey: 'k' }, { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'ok' }].map((_, index, all) => apply(all.slice(0, index + 1)));
    expect(states.map((state) => state.entries[0])).toMatchObject([{ status: 'requested' }, { status: 'running' }, { status: 'completed', output: 'ok' }]);
  });

  it('holds a pending approval until it is resolved or cancelled', () => {
    const requested = { type: 'tool.permission.requested', approvalId: 'ap', callId: 'c1', subjectDigest: 'd', options: [{ optionId: 'o', name: 'Allow', kind: 'allow_once' }] };
    const pending = apply([call, requested]);
    expect(pending.approval).toMatchObject({ approvalId: 'ap', callId: 'c1' });
    expect(pending.entries[0]).toMatchObject({ status: 'awaiting_approval' });
    expect(apply([call, requested, { type: 'tool.permission.resolved', approvalId: 'ap', optionId: 'o' }]).approval).toBeUndefined();
    expect(apply([call, requested, { type: 'tool.permission.cancelled', approvalId: 'ap', reason: 'withdrawn' }]).approval).toBeUndefined();
    expect(apply([call, requested, { type: 'tool.permission.resolved', approvalId: 'other', optionId: 'o' }]).approval).toBeDefined();
  });

  it('keeps the approvals of parallel subagents in order and shows each one after the previous is settled', () => {
    const option = [{ optionId: 'o', name: 'Allow', kind: 'allow_once' }];
    const childEvent = (runId: string, event: Record<string, unknown>): PublicRunEvent => ({ ...envelope, runId, ...event }) as PublicRunEvent;
    const toolCall = (runId: string): PublicRunEvent => childEvent(runId, { ...call, callId: 'c1' });
    const request = (runId: string, approvalId: string): PublicRunEvent => childEvent(runId, { type: 'tool.permission.requested', approvalId, callId: 'c1', subjectDigest: 'd', options: option });
    const settle = (runId: string, approvalId: string): PublicRunEvent => childEvent(runId, { type: 'tool.permission.resolved', approvalId, optionId: 'o' });
    const both = [toolCall('a'), request('a', 'ap-a'), toolCall('b'), request('b', 'ap-b')].reduce((state, event) => reduceChildEvent(state, event, 'reviewer'), initialTranscript);

    expect(both.approval).toMatchObject({ approvalId: 'ap-a', callId: 'a/c1' });
    expect(both.queuedApprovals).toMatchObject([{ approvalId: 'ap-b', callId: 'b/c1' }]);
    const afterFirst = reduceChildEvent(both, settle('a', 'ap-a'), 'reviewer');
    expect(afterFirst.approval).toMatchObject({ approvalId: 'ap-b' });
    expect(afterFirst.queuedApprovals).toEqual([]);
    expect(afterFirst.entries).toMatchObject([{ callId: 'a/c1', status: 'requested' }, { callId: 'b/c1', status: 'awaiting_approval' }]);
    const queuedWithdrawn = reduceChildEvent(both, settle('b', 'ap-b'), 'reviewer');
    expect(queuedWithdrawn.approval).toMatchObject({ approvalId: 'ap-a' });
    expect(queuedWithdrawn.queuedApprovals).toEqual([]);
    expect(queuedWithdrawn.entries).toMatchObject([{ status: 'awaiting_approval' }, { status: 'requested' }]);
  });

  it('keeps the questions of parallel subagents in order', () => {
    const ask = (inputId: string, callId: string) => ({ type: 'tool.elicitation.requested', inputId, callId, server: 'remote', requests: [{ key: 'who', mode: 'url', message: 'Sign in', url: 'https://example.test/consent' }] });
    const both = apply([call, { ...call, callId: 'c2' }, ask('in-1', 'c1'), ask('in-2', 'c2')]);

    expect(both.elicitation).toMatchObject({ inputId: 'in-1' });
    expect(both.queuedElicitations).toMatchObject([{ inputId: 'in-2' }]);
    const next = reduceEvent(both, { ...envelope, type: 'tool.elicitation.resolved', inputId: 'in-1' } as unknown as PublicRunEvent);
    expect(next.elicitation).toMatchObject({ inputId: 'in-2' });
    expect(next.queuedElicitations).toEqual([]);
  });

  it('holds the reason the policy asked on the pending approval', () => {
    const requested = {
      type: 'tool.permission.requested',
      approvalId: 'ap',
      callId: 'c1',
      subjectDigest: 'd',
      reason: 'edit outside the workspace requires approval',
      options: [{ optionId: 'o', name: 'Allow', kind: 'allow_once' }],
    };

    expect(apply([call, requested]).approval?.reason).toBe('edit outside the workspace requires approval');
  });

  it('does not queue an approval it already holds', () => {
    const requested = { type: 'tool.permission.requested', approvalId: 'ap', callId: 'c1', subjectDigest: 'd', options: [] };

    expect(apply([call, requested, requested]).queuedApprovals).toEqual([]);
  });

  it('marks an interrupted tool as unknown with the reconciliation text', () => {
    const state = apply([call, { type: 'tool.reconciled', callId: 'c1', outcome: 'unknown', output: 'effect unknown' }]);
    expect(state.entries[0]).toMatchObject({ status: 'unknown', output: 'effect unknown' });
  });

  it('keeps usage and the context size of the last model response', () => {
    const state = apply([
      { type: 'usage.updated', inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { type: 'model.responded', attempt: 0, response: { status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ]);
    expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(state.contextTokens).toBe(15);
  });

  it('records notices and compaction, and clears the approval when the run ends', () => {
    const state = apply([
      { type: 'notice', level: 'warning', message: 'careful' },
      { type: 'context.compacted', summary: 's', replacedThroughSeq: 3 },
      { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' },
    ]);
    expect(state.entries).toEqual([
      { kind: 'notice', level: 'warning', text: 'careful' },
      { kind: 'notice', level: 'info', text: 'context compacted' },
    ]);
    expect(state.runStatus).toBe('COMPLETED');
  });

  it('shows the plan live and folds it into the transcript when the run ends', () => {
    const plan = { type: 'plan.updated', entries: [{ content: 'step one', priority: 'high', status: 'completed' }] };
    const live = apply([plan]);
    expect(live.entries[0]).toMatchObject({ kind: 'plan' });
    expect(settledCount(live.entries)).toBe(0);
    const ended = apply([plan, { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }]);
    expect(ended.entries).toEqual([{ kind: 'info', text: '[x] step one' }]);
  });

  it('ignores events it has no view for', () => {
    expect(apply([{ type: 'instructions.loaded', path: '/a' }])).toEqual(initialTranscript);
  });
});

describe('settledCount', () => {
  it('counts the leading entries that can no longer change', () => {
    const state = apply([call, { type: 'agent.message.delta', attempt: 0, itemId: 'a', text: 'x' }]);
    expect(settledCount(state.entries)).toBe(0);
    const done = apply([call, { type: 'tool.completed', callId: 'c1', status: 'completed', output: '' }, { type: 'agent.message.delta', attempt: 0, itemId: 'a', text: 'x' }]);
    expect(settledCount(done.entries)).toBe(1);
  });
});

describe('hooks, auto mode and denials', () => {
  it('keeps the denial on the failed call', () => {
    const state = apply([call, { type: 'tool.completed', callId: 'c1', status: 'failed', output: 'Permission denied: no', denial: { source: 'rule', reason: 'Write(/a) is denied' } }]);
    expect(state.entries[0]).toMatchObject({ status: 'failed', denial: { source: 'rule', reason: 'Write(/a) is denied' } });
  });

  it('appends a notice for a hook run at the level of its outcome', () => {
    const state = apply([
      { type: 'hook.completed', hookEvent: 'PreToolUse', command: 'check.sh', outcome: 'blocked', exitCode: 2, message: 'frozen', durationMs: 1 },
      { type: 'hook.completed', hookEvent: 'PostToolUse', command: 'fmt.sh', outcome: 'success', exitCode: 0, durationMs: 1 },
      { type: 'hook.completed', hookEvent: 'PostToolUse', command: 'fmt.sh', outcome: 'timed_out', durationMs: 1 },
    ]);
    expect(state.entries).toEqual([
      { kind: 'notice', level: 'warning', text: 'hook PreToolUse blocked (exit 2): check.sh\n  frozen' },
      { kind: 'notice', level: 'info', text: 'hook PostToolUse succeeded (exit 0): fmt.sh' },
      { kind: 'notice', level: 'error', text: 'hook PostToolUse timed out: fmt.sh' },
    ]);
  });

  it('appends a notice for the classifier verdict under the title of the call', () => {
    const state = apply([call, { type: 'tool.permission.classified', callId: 'c1', model: 'guard', outcome: 'allow', verdict: 'safe', confidence: 'high' }]);
    expect(state.entries[1]).toEqual({ kind: 'notice', level: 'info', text: 'auto mode allowed Read /a; classifier guard judged Read /a safe with high confidence' });
  });
});

describe('nextMode', () => {
  it('cycles default, acceptEdits, plan and back, skipping bypassPermissions unless the session may use it', () => {
    expect(nextMode({ current: 'default', bypassAllowed: false, autoAvailable: false })).toBe('acceptEdits');
    expect(nextMode({ current: 'acceptEdits', bypassAllowed: false, autoAvailable: false })).toBe('plan');
    expect(nextMode({ current: 'plan', bypassAllowed: false, autoAvailable: false })).toBe('default');
    expect(nextMode({ current: 'plan', bypassAllowed: true, autoAvailable: false })).toBe('bypassPermissions');
    expect(nextMode({ current: 'bypassPermissions', bypassAllowed: true, autoAvailable: false })).toBe('default');
  });

  it('leaves the unavailable auto mode for the first mode', () => {
    expect(nextMode({ current: 'auto', bypassAllowed: false, autoAvailable: false })).toBe('default');
  });

  it('puts auto between plan and bypassPermissions when a classifier is configured', () => {
    expect(nextMode({ current: 'plan', bypassAllowed: false, autoAvailable: true })).toBe('auto');
    expect(nextMode({ current: 'auto', bypassAllowed: false, autoAvailable: true })).toBe('default');
    expect(nextMode({ current: 'auto', bypassAllowed: true, autoAvailable: true })).toBe('bypassPermissions');
  });
});

describe('waiting and subagent runs', () => {
  it('names what the run waits for until the run leaves the waiting status', () => {
    const waiting = apply([
      { type: 'run.status', from: 'RUNNING', to: 'WAITING_TOOL' },
      { type: 'tool.waiting', callId: 'c1', awaits: { kind: 'run', runId: 'child', sessionId: 's2', agent: 'reviewer' } },
    ]);
    expect(waiting).toMatchObject({ runStatus: 'WAITING_TOOL', waiting: 'subagent reviewer' });
    const job = apply([{ type: 'tool.waiting', callId: 'c2', awaits: { kind: 'job', jobId: 'bash_1' } }]);
    expect(job.waiting).toBe('job bash_1');
    const woken = reduceEvent(waiting, { ...envelope, type: 'run.status', from: 'WAITING_TOOL', to: 'QUEUED' } as PublicRunEvent);
    expect(woken.waiting).toBeUndefined();
  });

  it('shows the call and the approval of a child run without touching the status or the text of the run', () => {
    const state = [
      { ...envelope, runId: 'child', type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Edit', kind: 'edit', title: 'Edit /a', rawInput: {} },
      { ...envelope, runId: 'child', type: 'tool.permission.requested', approvalId: 'ap-1', callId: 'c1', subjectDigest: 'd', options: [], expiresAt: 10 },
      { ...envelope, runId: 'child', type: 'agent.message.delta', attempt: 0, itemId: 'm', text: 'child text' },
      { ...envelope, runId: 'child', type: 'run.status', from: 'RUNNING', to: 'COMPLETED' },
    ].reduce((current, event) => reduceChildEvent(current, event as PublicRunEvent, 'reviewer'), initialTranscript);

    expect(state.entries).toMatchObject([{ kind: 'tool', callId: 'child/c1', title: 'reviewer: Edit /a', status: 'awaiting_approval' }]);
    expect(state.approval).toMatchObject({ approvalId: 'ap-1', callId: 'child/c1' });
    expect(state.runStatus).toBeUndefined();
  });
});
