import { describe, expect, it } from 'vitest';
import { UnsupportedToolContent, createMapperState, mapChildEvent, mapRunEvent, toolCallIdOf, toolContentOf } from '../src/acp/events.ts';
import type { ClientFeatures, Phase } from '../src/acp/events.ts';
import { frameOf } from './acp-harness.ts';
import type { EventPayload } from './acp-harness.ts';

const NONE: ClientFeatures = { notices: false, compaction: false, elicitation: { form: false, url: false } };
const ALL: ClientFeatures = { notices: true, compaction: true, elicitation: { form: true, url: true } };

const map = (payload: EventPayload, options: { phase?: Phase; features?: ClientFeatures; state?: ReturnType<typeof createMapperState>; seq?: number } = {}) =>
  mapRunEvent(frameOf('run-1', options.seq ?? 1, payload).data, options.phase ?? 'live', options.state ?? createMapperState(), options.features ?? NONE);

const call = { type: 'tool.call', callId: 'call-1', providerCallId: 'call-1', name: 'Edit', kind: 'edit', title: 'Edit a.txt', rawInput: { file_path: '/a.txt' } } as const;

describe('messages', () => {
  it('maps agent text and thought deltas to one chunk of a message keyed by run and item, sent when the model response completes the item', () => {
    const state = createMapperState();
    expect(map({ type: 'agent.message.delta', step: 1, attempt: 0, itemId: 'm1', text: 'Hi' }, { state })).toEqual([]);
    expect(map({ type: 'agent.thought.delta', step: 1, attempt: 0, itemId: 'm2', text: 'Hmm' }, { state })).toEqual([]);
    expect(map({ type: 'model.responded', step: 1, attempt: 0, response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }, { state })).toEqual([
      { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' }, messageId: 'run-1/m1' } },
      { kind: 'update', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Hmm' }, messageId: 'run-1/m2' } },
    ]);
  });

  it('echoes the user message only when replaying history', () => {
    expect(map({ type: 'user.message', text: 'Do it' }, { phase: 'live' })).toEqual([]);
    expect(map({ type: 'user.message', text: 'Do it' }, { phase: 'history' })).toEqual([
      { kind: 'update', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Do it' }, messageId: 'run-1/user' } },
    ]);
  });
});

describe('tool calls', () => {
  it('announces a call as pending with its kind, input and locations under an id unique to the run', () => {
    const state = createMapperState();

    const effects = map({ ...call, locations: [{ path: '/a.txt', line: 3 }, { path: '/b.txt' }] }, { state });

    expect(effects).toEqual([
      {
        kind: 'update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'run-1/call-1',
          title: 'Edit a.txt',
          name: 'Edit',
          kind: 'edit',
          status: 'pending',
          rawInput: { file_path: '/a.txt' },
          locations: [{ path: '/a.txt', line: 3 }, { path: '/b.txt' }],
        },
      },
    ]);
    expect(toolCallIdOf('run-1', 'call-1')).toBe('run-1/call-1');
    expect(state.calls.has('run-1/call-1')).toBe(true);
  });

  it.each(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] as const)('keeps the ACP tool kind %s', (kind) => {
    const effects = map({ ...call, kind });

    expect(effects[0]).toMatchObject({ update: { kind } });
  });

  it('marks a started call in progress', () => {
    expect(map({ type: 'tool.started', callId: 'call-1', idemKey: 'k' })).toEqual([
      { kind: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'run-1/call-1', status: 'in_progress' } },
    ]);
  });

  it('passes the content of an update through as ACP tool call content', () => {
    const content = [
      { type: 'content', content: { type: 'text', text: 'partial' } },
      { type: 'diff', path: '/a.txt', oldText: null, newText: 'new' },
    ];

    expect(map({ type: 'tool.updated', callId: 'call-1', content })).toEqual([
      { kind: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'run-1/call-1', content } },
    ]);
  });

  it('completes a call with its content and raw output, or with its output as text when it has no content', () => {
    const diff = [{ type: 'diff', path: '/a.txt', oldText: 'a', newText: 'b' }];

    expect(map({ type: 'tool.completed', callId: 'call-1', status: 'completed', output: 'edited', content: diff })).toEqual([
      { kind: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'run-1/call-1', status: 'completed', content: diff, rawOutput: 'edited' } },
    ]);
    expect(map({ type: 'tool.completed', callId: 'call-1', status: 'failed', output: 'no such file' })).toEqual([
      {
        kind: 'update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'run-1/call-1',
          status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: 'no such file' } }],
          rawOutput: 'no such file',
        },
      },
    ]);
  });

  it.each([
    ['already_applied', 'completed'],
    ['not_applied', 'failed'],
    ['unknown', 'failed'],
  ] as const)('maps the reconciled outcome %s to the status %s', (outcome, status) => {
    expect(map({ type: 'tool.reconciled', callId: 'call-1', outcome, output: 'recovered' })).toEqual([
      {
        kind: 'update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'run-1/call-1',
          status,
          content: [{ type: 'content', content: { type: 'text', text: 'recovered' } }],
          rawOutput: 'recovered',
        },
      },
    ]);
  });

  it('refuses content that is not an ACP tool call content block', () => {
    expect(() => map({ type: 'tool.updated', callId: 'call-1', content: [{ type: 'image', data: 'AA==' }] })).toThrow(UnsupportedToolContent);
    expect(() => toolContentOf([{ type: 'diff', path: '/a', newText: 1 }])).toThrow(UnsupportedToolContent);
    expect(() => toolContentOf([{ type: 'content', content: { type: 'text' } }])).toThrow(UnsupportedToolContent);
    expect(() => toolContentOf(['text'])).toThrow(UnsupportedToolContent);
  });
});

describe('permission', () => {
  const options = [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  ] as const;

  it('asks about the call it announced, with the options of the runtime', () => {
    const state = createMapperState();
    map(call, { state });

    expect(map({ type: 'tool.permission.requested', approvalId: 'a1', callId: 'call-1', options: [...options], subjectDigest: 'd', reason: 'edits require approval', shown: { title: 'Edit a.txt', input: { file_path: '/a.txt' } } }, { state })).toEqual([
      {
        kind: 'permission',
        approvalId: 'a1',
        toolCall: { toolCallId: 'run-1/call-1', title: 'Edit a.txt', name: 'Edit', kind: 'edit', status: 'pending', rawInput: { file_path: '/a.txt' } },
        options,
      },
    ]);
  });

  it('shows what will run: the judged input, the effect, the claim of the model labelled and the change to the file', () => {
    const state = createMapperState();
    map(call, { state });
    const shown = {
      title: 'Edit a.txt',
      input: { file_path: '/a.txt', old_string: 'x', new_string: 'y' },
      effect: 'the effect',
      claim: 'Fix the typo',
      diff: { hunks: [{ oldStart: 1, newStart: 1, lines: ['-x', '+y'] }] },
    };
    const [effect] = map({ type: 'tool.permission.requested', approvalId: 'a1', callId: 'call-1', options: [...options], subjectDigest: 'd', reason: 'edits require approval', shown }, { state });
    expect(effect).toMatchObject({
      kind: 'permission',
      toolCall: {
        title: 'Edit a.txt',
        rawInput: shown.input,
        content: [{ type: 'content', content: { type: 'text', text: ['the effect', 'The model describes it as: Fix the typo', '@@ -1 +1 @@', '-x', '+y'].join('\n') } }],
      },
    });
  });

  it('refuses a request about a call nobody announced', () => {
    expect(() => map({ type: 'tool.permission.requested', approvalId: 'a1', callId: 'call-9', options: [...options], subjectDigest: 'd', reason: 'edits require approval', shown: { title: 'approval', input: {} } })).toThrow(
      'approval a1 asks about call call-9, which no tool.call event announced',
    );
  });

  it('withdraws the request when the approval is resolved or cancelled', () => {
    expect(map({ type: 'tool.permission.resolved', approvalId: 'a1', optionId: 'allow_once' })).toEqual([{ kind: 'withdraw', id: 'a1' }]);
    expect(map({ type: 'tool.permission.cancelled', approvalId: 'a1', reason: 'expired' })).toEqual([{ kind: 'withdraw', id: 'a1' }]);
  });
});

describe('elicitation', () => {
  const requests = [
    { key: 'who', mode: 'form', message: 'Who are you?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } },
    { key: 'login', mode: 'url', message: 'Sign in', url: 'https://example.com/login' },
  ] as const;

  it('asks for the input of an MCP server on behalf of the call, under an id unique to the run', () => {
    expect(map({ type: 'tool.elicitation.requested', inputId: 'in-1', callId: 'call-1', server: 'remote', requests: [...requests] })).toEqual([
      { kind: 'elicitation', inputId: 'in-1', toolCallId: 'run-1/call-1', server: 'remote', requests },
    ]);
  });

  it('withdraws the question when it is answered or cancelled', () => {
    expect(map({ type: 'tool.elicitation.resolved', inputId: 'in-1', responses: { who: { action: 'decline' } } })).toEqual([{ kind: 'withdraw', id: 'in-1' }]);
    expect(map({ type: 'tool.elicitation.cancelled', inputId: 'in-1', reason: 'expired' })).toEqual([{ kind: 'withdraw', id: 'in-1' }]);
  });
});

describe('plan, usage, mode', () => {
  it('maps the plan entries', () => {
    const entries = [
      { content: 'Read the file', priority: 'high', status: 'completed' },
      { content: 'Edit it', priority: 'medium', status: 'in_progress' },
    ] as const;

    expect(map({ type: 'plan.updated', entries: [...entries] })).toEqual([{ kind: 'update', update: { sessionUpdate: 'plan', entries } }]);
  });

  it('reports the tokens in context from the last model response, not the run total', () => {
    const state = createMapperState();
    map({ type: 'model.responded', step: 1, attempt: 0, response: { status: 'completed', output: [], usage: { input_tokens: 900, output_tokens: 100, total_tokens: 1000 } } }, { state });

    expect(map({ type: 'usage.updated', inputTokens: 5000, outputTokens: 700, totalTokens: 5700 }, { state })).toEqual([{ kind: 'usage', used: 1000 }]);
  });

  it('refuses usage that precedes any model response', () => {
    expect(() => map({ type: 'usage.updated', inputTokens: 1, outputTokens: 1, totalTokens: 2 })).toThrow('reported usage before any model response');
  });

  it('announces a mode change of the session only live', () => {
    expect(map({ type: 'mode.changed', mode: 'plan' })).toEqual([{ kind: 'update', update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } }]);
    expect(map({ type: 'mode.changed', mode: 'plan' }, { phase: 'history' })).toEqual([]);
  });
});

describe('compaction', () => {
  const compacted: EventPayload = { type: 'context.compacted', summary: 'We edited a file', replacedThroughSeq: 4 };

  it('reports a compaction by its run and sequence when the client advertised compaction', () => {
    expect(map(compacted, { features: ALL, seq: 9 })).toEqual([
      { kind: 'update', update: { sessionUpdate: 'compaction_update', compactionId: 'run-1/9', status: 'completed', summary: [{ type: 'text', text: 'We edited a file' }] } },
    ]);
    expect(map({ type: 'context.compaction_rejected' }, { features: ALL, seq: 10 })).toEqual([
      { kind: 'update', update: { sessionUpdate: 'compaction_update', compactionId: 'run-1/10', status: 'failed', error: 'the compaction summary was rejected' } },
    ]);
  });

  it('sends nothing to a client that did not advertise compaction', () => {
    expect(map(compacted, { features: NONE })).toEqual([]);
    expect(map({ type: 'context.compaction_rejected' }, { features: NONE })).toEqual([]);
  });
});

describe('notices', () => {
  it('sends a notice update to a client that advertised notices', () => {
    expect(map({ type: 'notice', level: 'warning', message: 'project skills were skipped' }, { features: ALL })).toEqual([
      { kind: 'update', update: { sessionUpdate: 'notice', severity: 'warning', title: 'project skills were skipped' } },
    ]);
  });

  it('shows the notice as agent text to a client that did not advertise notices', () => {
    expect(map({ type: 'notice', level: 'error', message: 'boom' }, { features: NONE, seq: 7 })).toEqual([
      { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'momonga error: boom\n' }, messageId: 'run-1/notice/7' } },
    ]);
  });

  it('shows the need for MCP authorization as a warning', () => {
    expect(map({ type: 'mcp.authorization.required', server: 'docs' }, { features: ALL })).toEqual([
      { kind: 'update', update: { sessionUpdate: 'notice', severity: 'warning', title: 'MCP server docs needs authorization' } },
    ]);
  });

  it('shows a hook run with its outcome, exit code and message, live only', () => {
    const hook = { type: 'hook.completed', hookEvent: 'PreToolUse', command: 'check.sh', outcome: 'blocked', exitCode: 2, decision: 'deny', message: 'writes are frozen', durationMs: 4, callId: 'call-1' } as const;
    expect(map(hook, { features: ALL })).toEqual([
      { kind: 'update', update: { sessionUpdate: 'notice', severity: 'warning', title: 'hook PreToolUse blocked (exit 2, decision deny): check.sh\n  writes are frozen' } },
    ]);
    expect(map(hook, { phase: 'history', features: ALL })).toEqual([]);
  });

  it('shows the verdict of the auto mode classifier under the title of the call', () => {
    const state = createMapperState();
    map(call, { state });

    const effects = map(
      { type: 'tool.permission.classified', callId: 'call-1', subjectDigest: 'digest-1', model: 'guard', outcome: 'allow', verdict: 'safe', confidence: 'high', rationale: 'inside the workspace' },
      { state, features: ALL },
    );

    expect(effects).toEqual([
      { kind: 'update', update: { sessionUpdate: 'notice', severity: 'info', title: 'auto mode allowed Edit a.txt; classifier guard judged Edit a.txt safe with high confidence: inside the workspace' } },
    ]);
  });

  it('shows the source of a permission denial as the content of the failed call', () => {
    const effects = map({ type: 'tool.completed', callId: 'call-1', status: 'failed', output: 'Permission denied: writes are frozen', denial: { source: 'hook', reason: 'writes are frozen' } });

    expect(effects).toEqual([
      {
        kind: 'update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'run-1/call-1',
          status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: 'denied by a hook: writes are frozen' } }],
          rawOutput: 'Permission denied: writes are frozen',
        },
      },
    ]);
  });

  it('keeps notices out of a replayed history', () => {
    expect(map({ type: 'notice', level: 'warning', message: 'live only' }, { phase: 'history', features: ALL })).toEqual([]);
    expect(map({ type: 'mcp.authorization.required', server: 'docs' }, { phase: 'history', features: ALL })).toEqual([]);
  });
});

describe('events that are not part of the conversation', () => {
  it.each([
    { type: 'run.started', attempt: 1 },
    { type: 'run.status', from: 'QUEUED', to: 'RUNNING' },
    { type: 'model.requested', step: 1, attempt: 0, digest: 'd' },
    { type: 'model.stream.restarted', step: 1, attempt: 0, itemIds: [] },
    { type: 'context.truncated', callId: 'call-1', handle: 'h', kind: 'truncated' },
    { type: 'instructions.loaded', path: '/w/AGENTS.md' },
    { type: 'skill.activated', name: 'pdf' },
    { type: 'approval.rule.persisted', approvalId: 'a1', effect: 'allow', rule: 'Edit(/a.txt)' },
  ] as const)('maps $type to nothing', (payload) => {
    expect(map(payload as EventPayload, { features: ALL })).toEqual([]);
    expect(map(payload as EventPayload, { phase: 'history', features: ALL })).toEqual([]);
  });
});

describe('tool calls that wait', () => {
  it('shows a call waiting for a subagent or a job as in progress with what it waits for', () => {
    expect(map({ type: 'tool.waiting', callId: 'call-1', awaits: { kind: 'run', runId: 'child-1', sessionId: 's2', agent: 'reviewer' } })).toEqual([
      { kind: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: toolCallIdOf('run-1', 'call-1'), status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'waiting for subagent reviewer' } }] } },
    ]);
    expect(map({ type: 'tool.waiting', callId: 'call-2', awaits: { kind: 'job', jobId: 'bash_1' } })).toEqual([
      { kind: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: toolCallIdOf('run-1', 'call-2'), status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'waiting for job bash_1' } }] } },
    ]);
  });
});

describe('events of a subagent run', () => {
  const mapChild = (payload: EventPayload, state = createMapperState()) => mapChildEvent(frameOf('child-1', 1, payload).data, 'reviewer', state, NONE);

  it('announces the calls of the child under its own run and names the agent in the title', () => {
    const state = createMapperState();

    const effects = mapChild(call, state);

    expect(effects).toMatchObject([{ kind: 'update', update: { sessionUpdate: 'tool_call', title: 'reviewer: Edit a.txt', status: 'pending' } }]);
    expect(state.calls.size).toBe(1);
  });

  it('asks for the approval of a call of the child', () => {
    const state = createMapperState();
    mapChild(call, state);

    const effects = mapChild({ type: 'tool.permission.requested', approvalId: 'ap-1', callId: 'call-1', subjectDigest: 'd', reason: 'edits require approval', options: [], expiresAt: 10, shown: { title: 'approval', input: {} } } as EventPayload, state);

    expect(effects).toMatchObject([{ kind: 'permission', approvalId: 'ap-1', toolCall: { title: 'reviewer: Edit a.txt', status: 'pending' } }]);
  });

  it('shows nothing of the text, usage or status of the child', () => {
    const state = createMapperState();
    for (const payload of [
      { type: 'agent.message.delta', step: 1, attempt: 0, itemId: 'm1', text: 'Hi' },
      { type: 'usage.updated', inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' },
    ] as const) {
      expect(mapChild(payload as EventPayload, state)).toEqual([]);
    }
    expect(state.contextTokens).toBeUndefined();
  });
});
