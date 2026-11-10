import { describe, expect, it } from 'vitest';
import type { PermissionOption } from '@momonga/protocol';
import { SESSION, runView } from './fake-backend.ts';
import { INITIALIZE, MODEL_ALIASES, conflict, errorOf, frameOf, labelsOf, modeChangedFrame, modelChangedFrame, notFound, resultOf, startAgent, updatesOf } from './acp-harness.ts';
import type { EventPayload, Harness } from './acp-harness.ts';
import { RunApiError } from '../src/client/runtime-client.ts';
import { DaemonUnreachable, retryAfterRestore } from '../src/run/follow.ts';
import { virtualClock } from './fake-supervisor.ts';

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow Edit(/a.txt)', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Always reject Edit(/a.txt)', kind: 'reject_always' },
];

const NEW_SESSION = { cwd: SESSION.cwd, mcpServers: [] };

const open = async (harness: Harness, capabilities: unknown = {}): Promise<string> => {
  await harness.peer.request('initialize', { ...INITIALIZE, clientCapabilities: capabilities });
  const created = resultOf(await harness.peer.request('session/new', NEW_SESSION)) as { sessionId: string };
  return created.sessionId;
};

const prompt = (harness: Harness, sessionId: string, text: string) => harness.peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });

const toolCall = (callId = 'call-1'): EventPayload => ({
  type: 'tool.call',
  callId,
  providerCallId: callId,
  name: 'Edit',
  kind: 'edit',
  title: 'Edit a.txt',
  rawInput: { file_path: '/a.txt' },
  locations: [{ path: '/a.txt' }],
});

const message = (itemId: string, text: string): EventPayload => ({ type: 'agent.message.delta', step: 1, attempt: 0, itemId, text });

const finishedRun = (status: 'COMPLETED' | 'CANCELLED' = 'COMPLETED') => runView({ id: 'run-1', status });

describe('initialize', () => {
  it('answers with the protocol version, the agent identity and only the capabilities it implements', async () => {
    const harness = startAgent();

    const result = resultOf(await harness.peer.request('initialize', INITIALIZE));

    expect(result).toEqual({
      protocolVersion: 1,
      agentInfo: { name: 'momonga', title: 'MomongaCode', version: '9.9.9' },
      agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true }, mcpCapabilities: { http: true, sse: false } },
      authMethods: [],
    });
    await harness.peer.close();
  });

  it('refuses a protocol version below 1 and names the supported ones', async () => {
    const harness = startAgent();

    const failure = errorOf(await harness.peer.request('initialize', { protocolVersion: 0, clientCapabilities: {} }));

    expect(failure).toMatchObject({ code: -32022, data: { requested: 0, supported: [1] } });
    await harness.peer.close();
  });

  it('answers a newer protocol version with version 1', async () => {
    const harness = startAgent();

    expect(resultOf(await harness.peer.request('initialize', { protocolVersion: 7, clientCapabilities: {} }))).toMatchObject({ protocolVersion: 1 });
    await harness.peer.close();
  });

  it('refuses every other request until the connection is initialized', async () => {
    const harness = startAgent();

    expect(errorOf(await harness.peer.request('session/new', NEW_SESSION)).code).toBe(-32600);
    expect(harness.runtime.calls).toEqual([]);
    await harness.peer.close();
  });
});

describe('session/new', () => {
  it('creates a Run API session with the editor MCP servers translated and answers with the selectable modes', async () => {
    const harness = startAgent();
    await harness.peer.request('initialize', INITIALIZE);

    const result = resultOf(
      await harness.peer.request('session/new', {
        cwd: SESSION.cwd,
        mcpServers: [
          { name: 'fx', command: 'node', args: ['server.js'], env: [{ name: 'A', value: 'b' }] },
          { type: 'http', name: 'docs', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer x' }] },
        ],
      }),
    );

    expect(result).toEqual({
      sessionId: SESSION.id,
      modes: {
        currentModeId: 'manual',
        availableModes: [
          { id: 'manual', name: 'Manual', description: 'asks before every file change and command' },
          { id: 'acceptEdits', name: 'Accept edits', description: 'accepts file edits inside the workspace, asks before commands' },
          { id: 'plan', name: 'Plan', description: 'read-only tools, the agent proposes a plan' },
        ],
      },
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: SESSION.modelAlias,
          options: MODEL_ALIASES.map((alias) => ({ value: alias, name: alias })),
        },
      ],
    });
    expect(harness.runtime.calls[0]).toBe(
      `createSession ${JSON.stringify({
        cwd: SESSION.cwd,
        mcpServers: {
          fx: { type: 'stdio', command: 'node', args: ['server.js'], env: { A: 'b' } },
          docs: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
        },
      })}`,
    );
    await harness.peer.close();
  });

  it('offers bypassPermissions only when the Run API session may use it', async () => {
    const harness = startAgent();
    harness.runtime.session = { ...SESSION, bypassAllowed: true };
    await harness.peer.request('initialize', INITIALIZE);

    const result = resultOf(await harness.peer.request('session/new', NEW_SESSION)) as { modes: { availableModes: { id: string }[] } };

    expect(result.modes.availableModes.map((mode) => mode.id)).toEqual(['manual', 'acceptEdits', 'plan', 'bypassPermissions']);
    await harness.peer.close();
  });

  it('refuses an sse MCP server with invalid params and creates no session', async () => {
    const harness = startAgent();
    await harness.peer.request('initialize', INITIALIZE);

    const failure = errorOf(await harness.peer.request('session/new', { cwd: SESSION.cwd, mcpServers: [{ type: 'sse', name: 'legacy', url: 'https://example.com/sse', headers: [] }] }));

    expect(failure.code).toBe(-32602);
    expect(harness.runtime.calls).toEqual([]);
    await harness.peer.close();
  });

  it('refuses two MCP servers with one name', async () => {
    const harness = startAgent();
    await harness.peer.request('initialize', INITIALIZE);

    const failure = errorOf(
      await harness.peer.request('session/new', {
        cwd: SESSION.cwd,
        mcpServers: [
          { name: 'fx', command: 'a', args: [], env: [] },
          { name: 'fx', command: 'b', args: [], env: [] },
        ],
      }),
    );

    expect(failure.code).toBe(-32602);
    await harness.peer.close();
  });

  it('turns a refusal of the Run API into invalid params that keep its code', async () => {
    const harness = startAgent();
    harness.runtime.createSession = async () => {
      throw conflict('config_error', 'the settings are invalid');
    };
    await harness.peer.request('initialize', INITIALIZE);

    const failure = errorOf(await harness.peer.request('session/new', NEW_SESSION));

    expect(failure).toMatchObject({ code: -32602, data: { status: 409, code: 'config_error' } });
    await harness.peer.close();
  });

  it('announces the skills of the session as commands after it has answered', async () => {
    const harness = startAgent();
    harness.runtime.skillList = { skills: [{ name: 'pdf', description: 'Extract PDF text', scope: 'project', location: '/w/SKILL.md' }], warnings: [] };
    await harness.peer.request('initialize', INITIALIZE);

    await harness.peer.request('session/new', NEW_SESSION);
    await harness.peer.untilReceived((message) => 'method' in message && message.method === 'session/update');

    expect(labelsOf(harness.peer.received)).toEqual(['result:1', 'result:2', 'update:available_commands_update']);
    expect(updatesOf(harness.peer.received)).toEqual([{ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'pdf', description: 'Extract PDF text' }] }]);
    await harness.peer.close();
  });
});

describe('session/prompt', () => {
  it('creates a run from the text, forwards its events in order without echoing the user message, and ends the turn', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.scripts.set('run-1', async ({ onEvent }) => {
      onEvent(frameOf('run-1', 1, { type: 'user.message', text: 'Say hello' }));
      onEvent(frameOf('run-1', 2, message('m1', 'Hel')));
      onEvent(frameOf('run-1', 3, message('m1', 'lo')));
      return finishedRun();
    });

    const result = resultOf(await prompt(harness, sessionId, 'Say hello'));

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(harness.runtime.calls).toContain(`createRun ${sessionId} ${JSON.stringify({ input: 'Say hello' })}`);
    expect(updatesOf(harness.peer.received).filter((update) => update.sessionUpdate !== 'available_commands_update')).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' }, messageId: 'run-1/m1' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' }, messageId: 'run-1/m1' },
    ]);
    await harness.peer.close();
  });

  it('turns the text of resource links and embedded text resources into the input', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.scripts.set('run-1', async () => finishedRun());

    await harness.peer.request('session/prompt', {
      sessionId,
      prompt: [
        { type: 'text', text: 'Look at' },
        { type: 'resource_link', name: 'a.txt', uri: 'file:///w/a.txt' },
        { type: 'resource', resource: { uri: 'file:///w/b.txt', text: 'bee' } },
      ],
    });

    const created = harness.runtime.calls.find((call) => call.startsWith('createRun'));
    expect(created).toBe(`createRun ${sessionId} ${JSON.stringify({ input: 'Look at\n[a.txt](file:///w/a.txt)\n<resource uri="file:///w/b.txt">\nbee\n</resource>' })}`);
    await harness.peer.close();
  });

  it('refuses a prompt with an image, which the agent did not advertise', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);

    const failure = errorOf(await harness.peer.request('session/prompt', { sessionId, prompt: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] }));

    expect(failure.code).toBe(-32602);
    expect(harness.runtime.calls.some((call) => call.startsWith('createRun'))).toBe(false);
    await harness.peer.close();
  });

  it('runs a slash prompt that names a skill of the session with that skill', async () => {
    const harness = startAgent();
    harness.runtime.skillList = { skills: [{ name: 'pdf', description: 'Extract PDF text', scope: 'project', location: '/w/SKILL.md' }], warnings: [] };
    const sessionId = await open(harness);
    await harness.peer.untilReceived((received) => 'method' in received && received.method === 'session/update');
    harness.scripts.set('run-1', async () => finishedRun());

    await prompt(harness, sessionId, '/pdf summarize it');
    await prompt(harness, sessionId, '/unknown thing');
    expect(errorOf(await prompt(harness, sessionId, '/pdf')).code).toBe(-32602);

    const created = harness.runtime.calls.filter((call) => call.startsWith('createRun'));
    expect(created).toEqual([
      `createRun ${sessionId} ${JSON.stringify({ input: 'summarize it', skill: 'pdf' })}`,
      `createRun ${sessionId} ${JSON.stringify({ input: '/unknown thing' })}`,
    ]);
    await harness.peer.close();
  });

  it('answers a session it does not know with resource not found', async () => {
    const harness = startAgent();
    await open(harness);

    expect(errorOf(await prompt(harness, 'no-such-session', 'hello'))).toMatchObject({ code: -32002, data: { sessionId: 'no-such-session' } });
    await harness.peer.close();
  });

  it('refuses a second prompt while the first is still running', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    const release = Promise.withResolvers<void>();
    harness.scripts.set('run-1', async () => {
      await release.promise;
      return finishedRun();
    });

    const first = prompt(harness, sessionId, 'one');
    await harness.runtime.called('createRun');
    const second = errorOf(await prompt(harness, sessionId, 'two'));
    release.resolve();

    expect(second.code).toBe(-32600);
    expect(resultOf(await first)).toEqual({ stopReason: 'end_turn' });
    expect(harness.runtime.calls.filter((call) => call.startsWith('createRun'))).toHaveLength(1);
    await harness.peer.close();
  });

  it('allows the next prompt once the first has ended', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.scripts.set('run-1', async () => finishedRun());

    await prompt(harness, sessionId, 'one');

    expect(resultOf(await prompt(harness, sessionId, 'two'))).toEqual({ stopReason: 'end_turn' });
    await harness.peer.close();
  });

  it.each([
    [runView({ id: 'run-1', status: 'STOPPED', stopReason: 'max_steps' }), 'max_turn_requests'],
    [runView({ id: 'run-1', status: 'STOPPED', stopReason: 'refusal' }), 'refusal'],
    [runView({ id: 'run-1', status: 'CANCELLED' }), 'cancelled'],
  ])('maps the end of the run %# to the stop reason %s', async (run, stopReason) => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.scripts.set('run-1', async () => run);

    expect(resultOf(await prompt(harness, sessionId, 'go'))).toEqual({ stopReason });
    await harness.peer.close();
  });

  it('fails the prompt with the run error when the run failed', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.scripts.set('run-1', async () => runView({ id: 'run-1', status: 'FAILED', error: { code: 'model_failed', message: 'the model call failed' } }));

    const failure = errorOf(await prompt(harness, sessionId, 'go'));

    expect(failure.code).toBe(-32603);
    expect(JSON.stringify(failure)).toContain('model_failed');
    await harness.peer.close();
  });

  it('fails the prompt when following the run fails', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.scripts.set('run-1', async () => {
      throw new Error('the event stream is gone');
    });

    const failure = errorOf(await prompt(harness, sessionId, 'go'));

    expect(JSON.stringify(failure)).toContain('the event stream is gone');
    await harness.peer.close();
  });

  it('turns a refusal of the Run API into invalid params', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.runtime.failures.set('createRun', new RunApiError('POST /v1/sessions/x/runs', 422, JSON.stringify({ error: { type: 'invalid_request_error', code: 'unknown_skill', message: 'no such skill' } })));

    expect(errorOf(await prompt(harness, sessionId, 'go'))).toMatchObject({ code: -32602, data: { status: 422, code: 'unknown_skill' } });
    await harness.peer.close();
  });
});

describe('permission requests', () => {
  const requestedScript = (harness: Harness, afterRequested: () => Promise<void>) => {
    harness.scripts.set('run-1', async ({ onEvent }) => {
      onEvent(frameOf('run-1', 1, toolCall()));
      onEvent(frameOf('run-1', 2, { type: 'tool.permission.requested', approvalId: 'approval-1', callId: 'call-1', options: OPTIONS, subjectDigest: 'd', reason: 'edits require approval' }));
      await afterRequested();
      return finishedRun();
    });
  };

  it('asks the client after the tool call update with the four options and resolves the approval with the option it selected', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.peer.answerRequests(() => ({ outcome: { outcome: 'selected', optionId: 'allow_always' } }));
    requestedScript(harness, () => harness.runtime.called('resolveApproval'));

    const result = resultOf(await prompt(harness, sessionId, 'edit'));

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(harness.runtime.calls).toContain('getApproval approval-1');
    expect(harness.runtime.calls).toContain('resolveApproval approval-1 allow_always');
    const labels = labelsOf(harness.peer.received);
    expect(labels.indexOf('update:tool_call')).toBeLessThan(labels.indexOf('session/request_permission'));
    const asked = harness.peer.received.find((message) => 'method' in message && message.method === 'session/request_permission');
    expect(asked && 'params' in asked ? asked.params : undefined).toEqual({
      sessionId,
      toolCall: { toolCallId: 'run-1/call-1', title: 'Edit a.txt', name: 'Edit', kind: 'edit', status: 'pending', rawInput: { file_path: '/a.txt' }, locations: [{ path: '/a.txt' }] },
      options: OPTIONS,
    });
    await harness.peer.close();
  });

  it('does not ask when the approval is no longer pending', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.runtime.approvalStatus = 'resolved';
    harness.peer.answerRequests(() => {
      throw new Error('the client must not be asked');
    });
    requestedScript(harness, () => harness.runtime.called('getApproval'));

    await prompt(harness, sessionId, 'edit');

    expect(labelsOf(harness.peer.received)).not.toContain('session/request_permission');
    expect(harness.runtime.calls.some((call) => call.startsWith('resolveApproval'))).toBe(false);
    await harness.peer.close();
  });

  it('resolves nothing when the client answers cancelled, and the cancel notification cancels the run', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    const answered = Promise.withResolvers<void>();
    harness.peer.answerRequests(() => {
      answered.resolve();
      return { outcome: { outcome: 'cancelled' } };
    });
    harness.scripts.set('run-1', async ({ onEvent }) => {
      onEvent(frameOf('run-1', 1, toolCall()));
      onEvent(frameOf('run-1', 2, { type: 'tool.permission.requested', approvalId: 'approval-1', callId: 'call-1', options: OPTIONS, subjectDigest: 'd', reason: 'edits require approval' }));
      await harness.runtime.called('cancel');
      return finishedRun('CANCELLED');
    });

    const pending = prompt(harness, sessionId, 'edit');
    await answered.promise;
    await harness.peer.notify('session/cancel', { sessionId });

    expect(resultOf(await pending)).toEqual({ stopReason: 'cancelled' });
    expect(harness.runtime.calls).toContain('cancel run-1');
    expect(harness.runtime.calls.some((call) => call.startsWith('resolveApproval'))).toBe(false);
    await harness.peer.close();
  });

  it('cancels the outstanding request when the runtime withdraws the approval', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.peer.answerRequests(async () => {
      await harness.peer.untilReceived((message) => 'method' in message && message.method === '$/cancel_request');
      throw Object.assign(new Error('Request cancelled'), { code: -32800 });
    });
    harness.scripts.set('run-1', async ({ onEvent }) => {
      onEvent(frameOf('run-1', 1, toolCall()));
      onEvent(frameOf('run-1', 2, { type: 'tool.permission.requested', approvalId: 'approval-1', callId: 'call-1', options: OPTIONS, subjectDigest: 'd', reason: 'edits require approval' }));
      await harness.peer.untilReceived((message) => 'method' in message && message.method === 'session/request_permission');
      onEvent(frameOf('run-1', 3, { type: 'tool.permission.cancelled', approvalId: 'approval-1', reason: 'withdrawn' }));
      return finishedRun('CANCELLED');
    });

    const result = resultOf(await prompt(harness, sessionId, 'edit'));

    expect(result).toEqual({ stopReason: 'cancelled' });
    expect(harness.runtime.calls.some((call) => call.startsWith('resolveApproval'))).toBe(false);
    await harness.peer.close();
  });

  it('does not ask the client about an approval that was withdrawn while it was being read', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    const reading = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    const readApproval = harness.runtime.getApproval;
    harness.runtime.getApproval = async (id) => {
      reading.resolve();
      await read.promise;
      return readApproval(id);
    };
    harness.peer.answerRequests(() => {
      throw new Error('the client must not be asked');
    });
    harness.scripts.set('run-1', async ({ onEvent }) => {
      onEvent(frameOf('run-1', 1, toolCall()));
      onEvent(frameOf('run-1', 2, { type: 'tool.permission.requested', approvalId: 'approval-1', callId: 'call-1', options: OPTIONS, subjectDigest: 'd', reason: 'edits require approval' }));
      await reading.promise;
      onEvent(frameOf('run-1', 3, { type: 'tool.permission.cancelled', approvalId: 'approval-1', reason: 'withdrawn' }));
      read.resolve();
      return finishedRun('CANCELLED');
    });

    await prompt(harness, sessionId, 'edit');

    expect(labelsOf(harness.peer.received)).not.toContain('session/request_permission');
    await harness.peer.close();
  });

  it('keeps the session alive when the daemon connection drops while an approval is read, and asks once the daemon is back', async () => {
    const restored: number[] = [];
    const clock = virtualClock();
    const harness = startAgent({
      retryAfterRestore: (operation, signal) =>
        retryAfterRestore(
          {
            clock,
            random: () => 0.5,
            reconnectBoundMs: 10_000,
            boundExceeded: (boundMs, cause) => new DaemonUnreachable(boundMs, cause),
            restoreConnection: async () => void restored.push(restored.length),
            signal,
          },
          operation,
        ),
    });
    const sessionId = await open(harness);
    harness.runtime.failures.set('getApproval', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    harness.peer.answerRequests(() => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }));
    requestedScript(harness, () => harness.runtime.called('resolveApproval'));

    expect(resultOf(await prompt(harness, sessionId, 'edit'))).toEqual({ stopReason: 'end_turn' });

    expect(restored).toEqual([0]);
    expect(harness.reports).toEqual([]);
    expect(harness.runtime.calls.filter((call) => call.startsWith('getApproval'))).toHaveLength(2);
    await harness.peer.close();
  });

  it('treats an approval that was resolved elsewhere in the meantime as settled', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.runtime.failures.set('resolveApproval', conflict('approval_not_pending', 'approval approval-1 is resolved, not pending'));
    harness.peer.answerRequests(() => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }));
    requestedScript(harness, () => harness.runtime.called('resolveApproval'));

    expect(resultOf(await prompt(harness, sessionId, 'edit'))).toEqual({ stopReason: 'end_turn' });
    await harness.peer.close();
  });

  it('fails the prompt when the approval cannot be resolved for another reason', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.runtime.failures.set('resolveApproval', new RunApiError('POST /v1/approvals/approval-1', 400, JSON.stringify({ error: { type: 'invalid_request_error', code: 'invalid_request', message: 'option nope was not offered' } })));
    harness.peer.answerRequests(() => ({ outcome: { outcome: 'selected', optionId: 'nope' } }));
    harness.scripts.set('run-1', async ({ onEvent, signal }) => {
      onEvent(frameOf('run-1', 1, toolCall()));
      onEvent(frameOf('run-1', 2, { type: 'tool.permission.requested', approvalId: 'approval-1', callId: 'call-1', options: OPTIONS, subjectDigest: 'd', reason: 'edits require approval' }));
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw signal.reason;
    });

    const failure = errorOf(await prompt(harness, sessionId, 'edit'));

    expect(JSON.stringify(failure)).toContain('option nope was not offered');
    expect(harness.reports.join('\n')).toContain('option nope was not offered');
    await harness.peer.close();
  });
});

describe('elicitation', () => {
  const FORM = { key: 'who', mode: 'form', message: 'Who are you?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } } as const;

  const askedScript = (harness: Harness, afterRequested: () => Promise<void>) => {
    harness.scripts.set('run-1', async ({ onEvent }) => {
      onEvent(frameOf('run-1', 1, toolCall()));
      onEvent(frameOf('run-1', 2, { type: 'tool.elicitation.requested', inputId: 'in-1', callId: 'call-1', server: 'remote', requests: [FORM] }));
      await afterRequested();
      return finishedRun();
    });
  };

  it('asks the client inside the session and the tool call and gives the answer to the Run API', async () => {
    const harness = startAgent();
    const sessionId = await open(harness, { elicitation: { form: {} } });
    harness.peer.answerRequests(() => ({ action: 'accept', content: { name: 'Ada' } }));
    askedScript(harness, () => harness.runtime.called('resolveElicitation'));

    expect(resultOf(await prompt(harness, sessionId, 'ask me'))).toEqual({ stopReason: 'end_turn' });

    const asked = harness.peer.received.find((message) => 'method' in message && message.method === 'elicitation/create');
    expect(asked && 'params' in asked ? asked.params : undefined).toEqual({
      mode: 'form',
      sessionId,
      toolCallId: 'run-1/call-1',
      message: 'Who are you?',
      requestedSchema: FORM.requestedSchema,
    });
    expect(harness.runtime.calls).toContain(`resolveElicitation in-1 ${JSON.stringify({ who: { action: 'accept', content: { name: 'Ada' } } })}`);
    await harness.peer.close();
  });

  it('cancels the question and says so when the client cannot show that kind of question', async () => {
    const harness = startAgent();
    const sessionId = await open(harness, { elicitation: { url: {} } });
    harness.peer.answerRequests(() => {
      throw new Error('the client must not be asked');
    });
    askedScript(harness, () => harness.runtime.called('resolveElicitation'));

    await prompt(harness, sessionId, 'ask me');

    expect(labelsOf(harness.peer.received)).not.toContain('elicitation/create');
    expect(harness.runtime.calls).toContain(`resolveElicitation in-1 ${JSON.stringify({ who: { action: 'cancel' } })}`);
    expect(updatesOf(harness.peer.received).filter((update) => update.sessionUpdate === 'agent_message_chunk')).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'momonga warning: MCP server remote asked for input this client cannot show: Who are you?\n' },
        messageId: 'in-1/who',
      },
    ]);
    await harness.peer.close();
  });

  it('does not ask when the question has already been answered', async () => {
    const harness = startAgent();
    const sessionId = await open(harness, { elicitation: { form: {} } });
    harness.runtime.elicitationStatus = 'resolved';
    harness.peer.answerRequests(() => {
      throw new Error('the client must not be asked');
    });
    askedScript(harness, () => harness.runtime.called('getElicitation'));

    await prompt(harness, sessionId, 'ask me');

    expect(labelsOf(harness.peer.received)).not.toContain('elicitation/create');
    expect(harness.runtime.calls.some((call) => call.startsWith('resolveElicitation'))).toBe(false);
    await harness.peer.close();
  });

  it('cancels the outstanding question when the runtime withdraws it', async () => {
    const harness = startAgent();
    const sessionId = await open(harness, { elicitation: { form: {} } });
    harness.peer.answerRequests(async () => {
      await harness.peer.untilReceived((message) => 'method' in message && message.method === '$/cancel_request');
      throw Object.assign(new Error('Request cancelled'), { code: -32800 });
    });
    harness.scripts.set('run-1', async ({ onEvent }) => {
      onEvent(frameOf('run-1', 1, toolCall()));
      onEvent(frameOf('run-1', 2, { type: 'tool.elicitation.requested', inputId: 'in-1', callId: 'call-1', server: 'remote', requests: [FORM] }));
      await harness.peer.untilReceived((message) => 'method' in message && message.method === 'elicitation/create');
      onEvent(frameOf('run-1', 3, { type: 'tool.elicitation.cancelled', inputId: 'in-1', reason: 'expired' }));
      return finishedRun();
    });

    expect(resultOf(await prompt(harness, sessionId, 'ask me'))).toEqual({ stopReason: 'end_turn' });
    expect(harness.runtime.calls.some((call) => call.startsWith('resolveElicitation'))).toBe(false);
    await harness.peer.close();
  });

  it('treats a question that was answered elsewhere in the meantime as settled', async () => {
    const harness = startAgent();
    const sessionId = await open(harness, { elicitation: { form: {} } });
    harness.runtime.failures.set('resolveElicitation', conflict('approval_not_pending', 'elicitation in-1 is resolved, not pending'));
    harness.peer.answerRequests(() => ({ action: 'decline' }));
    askedScript(harness, () => harness.runtime.called('resolveElicitation'));

    expect(resultOf(await prompt(harness, sessionId, 'ask me'))).toEqual({ stopReason: 'end_turn' });
    await harness.peer.close();
  });
});

describe('session/cancel', () => {
  it('cancels the run of the turn', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.scripts.set('run-1', async () => {
      await harness.runtime.called('cancel');
      return finishedRun('CANCELLED');
    });

    const pending = prompt(harness, sessionId, 'long task');
    await harness.runtime.called('createRun');
    await harness.peer.notify('session/cancel', { sessionId });

    expect(resultOf(await pending)).toEqual({ stopReason: 'cancelled' });
    expect(harness.runtime.calls).toContain('cancel run-1');
    await harness.peer.close();
  });

  it('cancels the run as soon as it exists when the cancel arrives while it is being created', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    const created = Promise.withResolvers<void>();
    harness.runtime.createRunResult = async () => {
      await created.promise;
      return runView({ id: 'run-1', status: 'QUEUED' });
    };
    harness.scripts.set('run-1', async () => {
      await harness.runtime.called('cancel');
      return finishedRun('CANCELLED');
    });

    const pending = prompt(harness, sessionId, 'long task');
    await harness.runtime.called('createRun');
    await harness.peer.notify('session/cancel', { sessionId });
    await harness.peer.request('session/set_mode', { sessionId, modeId: 'plan' });
    created.resolve();

    expect(resultOf(await pending)).toEqual({ stopReason: 'cancelled' });
    expect(harness.runtime.calls.filter((call) => call === 'cancel run-1')).toHaveLength(1);
    await harness.peer.close();
  });

  it('retries the deferred cancel across a daemon restart like every other call, instead of failing the turn', async () => {
    const restored: number[] = [];
    const clock = virtualClock();
    const harness = startAgent({
      retryAfterRestore: (operation, signal) =>
        retryAfterRestore(
          {
            clock,
            random: () => 0.5,
            reconnectBoundMs: 10_000,
            boundExceeded: (boundMs, cause) => new DaemonUnreachable(boundMs, cause),
            restoreConnection: async () => void restored.push(restored.length),
            signal,
          },
          operation,
        ),
    });
    const sessionId = await open(harness);
    const created = Promise.withResolvers<void>();
    harness.runtime.createRunResult = async () => {
      await created.promise;
      return runView({ id: 'run-1', status: 'QUEUED' });
    };
    harness.runtime.failures.set('cancel', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    harness.scripts.set('run-1', async () => {
      await harness.runtime.called('cancel');
      return finishedRun('CANCELLED');
    });

    const pending = prompt(harness, sessionId, 'long task');
    await harness.runtime.called('createRun');
    await harness.peer.notify('session/cancel', { sessionId });
    await harness.peer.request('session/set_mode', { sessionId, modeId: 'plan' });
    created.resolve();

    expect(resultOf(await pending)).toEqual({ stopReason: 'cancelled' });
    expect(restored).toEqual([0]);
    expect(harness.runtime.calls.filter((call) => call === 'cancel run-1')).toHaveLength(2);
    await harness.peer.close();
  });

  it('cancels the run when the client cancels the prompt request itself', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.scripts.set('run-1', async () => {
      await harness.runtime.called('cancel');
      return finishedRun('CANCELLED');
    });

    const pending = prompt(harness, sessionId, 'long task');
    await harness.runtime.called('createRun');
    await harness.peer.notify('$/cancel_request', { requestId: 3 });
    await pending;

    expect(harness.runtime.calls).toContain('cancel run-1');
    await harness.peer.close();
  });

  it.each([
    [runView({ id: 'run-1', status: 'COMPLETED' })],
    [runView({ id: 'run-1', status: 'STOPPED', stopReason: 'max_steps' })],
    [runView({ id: 'run-1', status: 'FAILED', error: { code: 'aborted', message: 'the model call was aborted' } })],
  ])('answers cancelled when the run ended another way %# after the cancel was requested', async (ended) => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.scripts.set('run-1', async () => {
      await harness.runtime.called('cancel');
      return ended;
    });

    const pending = prompt(harness, sessionId, 'long task');
    await harness.runtime.called('createRun');
    await harness.peer.notify('session/cancel', { sessionId });

    expect(resultOf(await pending)).toEqual({ stopReason: 'cancelled' });
    await harness.peer.close();
  });

  it('does nothing for a session without a turn or one it does not know', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);

    await harness.peer.notify('session/cancel', { sessionId });
    await harness.peer.notify('session/cancel', { sessionId: 'no-such-session' });
    await harness.peer.request('session/set_mode', { sessionId, modeId: 'plan' });

    expect(harness.runtime.calls.some((call) => call.startsWith('cancel'))).toBe(false);
    await harness.peer.close();
  });
});

describe('session/set_mode', () => {
  it('changes the mode of the Run API session and passes on the change the runtime reports for the session', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);

    const response = await harness.peer.request('session/set_mode', { sessionId, modeId: 'acceptEdits' });

    expect(resultOf(response)).toEqual({});
    expect(harness.runtime.calls).toContain(`setPermissionMode ${sessionId} acceptEdits`);
    expect(updatesOf(harness.peer.received).filter((update) => update.sessionUpdate === 'current_mode_update')).toEqual([
      { sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' },
    ]);
    await harness.peer.close();
  });

  it('passes on a mode change another client made, and only the ones after the session was opened', async () => {
    const harness = startAgent();
    harness.runtime.session = { ...SESSION, lastEventId: 7 };
    const sessionId = await open(harness);

    harness.emitSessionEvent(modeChangedFrame(8, 'plan'));
    await harness.peer.untilReceived((message) => updatesOf([message])[0]?.sessionUpdate === 'current_mode_update');

    expect(harness.sessionStreams.map(({ sessionId: followed, after }) => ({ followed, after }))).toEqual([{ followed: sessionId, after: 7 }]);
    expect(updatesOf(harness.peer.received).filter((update) => update.sessionUpdate === 'current_mode_update')).toEqual([
      { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    ]);
    await harness.peer.close();
  });

  it('ignores the run events that the session stream carries as well', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    await harness.peer.untilReceived((received) => updatesOf([received])[0]?.sessionUpdate === 'available_commands_update');

    harness.emitSessionEvent(frameOf('run-1', 3, message('m1', 'seen by the run follower only')));
    harness.emitSessionEvent(modeChangedFrame(9, 'plan'));
    await harness.peer.untilReceived((received) => updatesOf([received])[0]?.sessionUpdate === 'current_mode_update');

    expect(sessionId).toBe(SESSION.id);
    expect(updatesOf(harness.peer.received).map((update) => update.sessionUpdate)).toEqual(['available_commands_update', 'current_mode_update']);
    await harness.peer.close();
  });

  it.each([['auto'], ['bypassPermissions'], ['nonsense']])('refuses the mode %s that the session does not offer', async (modeId) => {
    const harness = startAgent();
    const sessionId = await open(harness);

    const failure = errorOf(await harness.peer.request('session/set_mode', { sessionId, modeId }));

    expect(failure.code).toBe(-32602);
    expect(harness.runtime.calls.some((call) => call.startsWith('setPermissionMode'))).toBe(false);
    await harness.peer.close();
  });

  it('allows bypassPermissions in a session that may use it', async () => {
    const harness = startAgent();
    harness.runtime.session = { ...SESSION, bypassAllowed: true };
    const sessionId = await open(harness);

    expect(resultOf(await harness.peer.request('session/set_mode', { sessionId, modeId: 'bypassPermissions' }))).toEqual({});
    await harness.peer.close();
  });

  it('offers auto between plan and bypassPermissions only when a classifier is configured, and applies it', async () => {
    const harness = startAgent({ autoModeAvailable: async () => true });
    harness.runtime.session = { ...SESSION, bypassAllowed: true };
    await harness.peer.request('initialize', INITIALIZE);

    const result = resultOf(await harness.peer.request('session/new', { cwd: SESSION.cwd, mcpServers: [] })) as { sessionId: string; modes: { availableModes: { id: string }[] } };

    expect(result.modes.availableModes.map((mode) => mode.id)).toEqual(['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
    expect(resultOf(await harness.peer.request('session/set_mode', { sessionId: result.sessionId, modeId: 'auto' }))).toEqual({});
    expect(harness.runtime.calls).toContain(`setPermissionMode ${result.sessionId} auto`);
    await harness.peer.close();
  });

  it('turns a refusal of the Run API into invalid params', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.runtime.failures.set('setPermissionMode', conflict('mode_unavailable', 'auto mode is not available yet'));

    expect(errorOf(await harness.peer.request('session/set_mode', { sessionId, modeId: 'plan' }))).toMatchObject({ code: -32602, data: { code: 'mode_unavailable' } });
    await harness.peer.close();
  });
});

describe('model selection', () => {
  const modelOption = (currentValue: string) => ({
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue,
    options: MODEL_ALIASES.map((alias) => ({ value: alias, name: alias })),
  });

  const configUpdates = (harness: Harness) => updatesOf(harness.peer.received).filter((update) => update.sessionUpdate === 'config_option_update');

  it('offers the configured aliases as the model config option of a new session, the current one selected', async () => {
    const harness = startAgent();
    await harness.peer.request('initialize', INITIALIZE);

    const result = resultOf(await harness.peer.request('session/new', NEW_SESSION)) as { configOptions: unknown };

    expect(result.configOptions).toEqual([modelOption(SESSION.modelAlias)]);
    await harness.peer.close();
  });

  it('offers it again when a session is loaded, with the alias the session has now', async () => {
    const harness = startAgent();
    harness.runtime.session = { ...SESSION, modelAlias: 'fm-large' };
    await harness.peer.request('initialize', INITIALIZE);

    const result = resultOf(await harness.peer.request('session/load', { sessionId: SESSION.id, ...NEW_SESSION })) as { configOptions: unknown };

    expect(result.configOptions).toEqual([modelOption('fm-large')]);
    await harness.peer.close();
  });

  describe('when the model list cannot be read', () => {
    const unreadable = (): Promise<readonly string[]> => Promise.reject(new Error('the gateway is down'));

    const warningTexts = (harness: Harness): string[] =>
      updatesOf(harness.peer.received).flatMap(({ sessionUpdate, content }) =>
        sessionUpdate === 'agent_message_chunk' && typeof content === 'object' && content !== null && 'text' in content && typeof content.text === 'string' ? [content.text] : [],
      );

    it('creates the session without the model option and says why in a notice', async () => {
      const harness = startAgent({ modelAliases: unreadable });
      await harness.peer.request('initialize', INITIALIZE);

      const result = resultOf(await harness.peer.request('session/new', NEW_SESSION)) as { sessionId: string; configOptions: unknown };

      expect(result.sessionId).toBe(SESSION.id);
      expect(result.configOptions).toEqual([]);
      await harness.peer.untilReceived((message) => updatesOf([message])[0]?.sessionUpdate === 'agent_message_chunk');
      expect(warningTexts(harness)).toEqual(['momonga warning: the model option is not offered because the model list could not be read: the gateway is down\n']);
      await harness.peer.close();
    });

    it('loads the session without the model option and says why in a notice', async () => {
      const harness = startAgent({ modelAliases: unreadable });
      await harness.peer.request('initialize', INITIALIZE);

      const result = resultOf(await harness.peer.request('session/load', { sessionId: SESSION.id, ...NEW_SESSION })) as { configOptions: unknown };

      expect(result.configOptions).toEqual([]);
      await harness.peer.untilReceived((message) => updatesOf([message])[0]?.sessionUpdate === 'agent_message_chunk');
      expect(warningTexts(harness)).toEqual(['momonga warning: the model option is not offered because the model list could not be read: the gateway is down\n']);
      await harness.peer.close();
    });

    it('removes the option and says why when a model.changed event arrives and the list can no longer be read', async () => {
      let readable = true;
      const harness = startAgent({ modelAliases: () => (readable ? Promise.resolve(MODEL_ALIASES) : unreadable()) });
      await open(harness);
      readable = false;

      harness.emitSessionEvent(modelChangedFrame(5, 'fm-large', SESSION.modelAlias));
      await harness.peer.untilReceived((message) => updatesOf([message])[0]?.sessionUpdate === 'agent_message_chunk');

      expect(configUpdates(harness)).toEqual([{ sessionUpdate: 'config_option_update', configOptions: [] }]);
      expect(warningTexts(harness)).toEqual(['momonga warning: the model option is not offered because the model list could not be read: the gateway is down\n']);
      await harness.peer.close();
    });

    it('offers the option as before when the list can be read', async () => {
      const harness = startAgent();
      await harness.peer.request('initialize', INITIALIZE);

      const result = resultOf(await harness.peer.request('session/new', NEW_SESSION)) as { configOptions: unknown };

      expect(result.configOptions).toEqual([modelOption(SESSION.modelAlias)]);
      expect(warningTexts(harness)).toEqual([]);
      await harness.peer.close();
    });
  });

  it('switches the alias of the Run API session on session/set_config_option and answers the full option list', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);

    const response = resultOf(await harness.peer.request('session/set_config_option', { sessionId, configId: 'model', value: 'fm-large' }));

    expect(response).toEqual({ configOptions: [modelOption('fm-large')] });
    expect(harness.runtime.calls).toContain(`setModelAlias ${sessionId} fm-large`);
    await harness.peer.close();
  });

  it('passes on the model.changed event of the session as a config option update', async () => {
    const harness = startAgent();
    await open(harness);

    harness.emitSessionEvent(modelChangedFrame(5, 'fm-large', SESSION.modelAlias));
    await harness.peer.untilReceived((message) => updatesOf([message])[0]?.sessionUpdate === 'config_option_update');

    expect(configUpdates(harness)).toEqual([{ sessionUpdate: 'config_option_update', configOptions: [modelOption('fm-large')] }]);
    await harness.peer.close();
  });

  it('refuses an option it does not offer and an alias it does not list, without asking the Run API', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);

    const unknownOption = errorOf(await harness.peer.request('session/set_config_option', { sessionId, configId: 'temperature', value: 'high' }));
    const unknownAlias = errorOf(await harness.peer.request('session/set_config_option', { sessionId, configId: 'model', value: 'not-an-alias' }));

    expect(unknownOption.code).toBe(-32602);
    expect(unknownAlias.code).toBe(-32602);
    expect(harness.runtime.calls.some((call) => call.startsWith('setModelAlias'))).toBe(false);
    await harness.peer.close();
  });

  it('turns a refusal of the Run API into invalid params', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.runtime.failures.set('setModelAlias', conflict('model_unavailable', 'the gateway lists no such alias'));

    expect(errorOf(await harness.peer.request('session/set_config_option', { sessionId, configId: 'model', value: 'fm-large' }))).toMatchObject({
      code: -32602,
      data: { code: 'model_unavailable' },
    });
    await harness.peer.close();
  });
});

describe('session/load', () => {
  const history = (harness: Harness): void => {
    harness.runtime.runs = [runView({ id: 'run-1', status: 'COMPLETED', lastSeq: 3 })];
    harness.scripts.set('run-1', async ({ onEvent }) => {
      onEvent(frameOf('run-1', 1, { type: 'user.message', text: 'Say hello' }));
      onEvent(frameOf('run-1', 2, { type: 'notice', level: 'warning', message: 'live only' }));
      onEvent(frameOf('run-1', 3, message('m1', 'Hello')));
      return finishedRun();
    });
  };

  it('replays the conversation as updates, in order, before it answers with the modes', async () => {
    const harness = startAgent();
    history(harness);
    await harness.peer.request('initialize', INITIALIZE);

    const response = await harness.peer.request('session/load', { sessionId: SESSION.id, cwd: SESSION.cwd, mcpServers: [] });

    expect(resultOf(response)).toMatchObject({ modes: { currentModeId: 'manual' } });
    expect(labelsOf(harness.peer.received)).toEqual(['result:1', 'update:user_message_chunk', 'update:agent_message_chunk', 'result:2']);
    expect(updatesOf(harness.peer.received)).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Say hello' }, messageId: 'run-1/user' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' }, messageId: 'run-1/m1' },
    ]);
    await harness.peer.untilReceived((received) => 'method' in received && received.method === 'session/update' && updatesOf([received])[0]?.sessionUpdate === 'available_commands_update');
    await harness.peer.close();
  });

  it('gives the MCP servers of the request to the session and checks the working directory', async () => {
    const harness = startAgent();
    history(harness);
    await harness.peer.request('initialize', INITIALIZE);

    const wrongCwd = errorOf(await harness.peer.request('session/load', { sessionId: SESSION.id, cwd: '/elsewhere', mcpServers: [] }));
    expect(wrongCwd).toMatchObject({ code: -32602, data: { cwd: '/elsewhere', sessionCwd: SESSION.cwd } });
    expect(harness.runtime.calls.some((call) => call.startsWith('setMcpServers'))).toBe(false);

    await harness.peer.request('session/load', { sessionId: SESSION.id, cwd: SESSION.cwd, mcpServers: [{ name: 'fx', command: 'node', args: [], env: [] }] });

    expect(harness.runtime.calls).toContain(`setMcpServers ${SESSION.id} ${JSON.stringify({ fx: { type: 'stdio', command: 'node', args: [], env: {} } })}`);
    await harness.peer.close();
  });

  it('answers an unknown session with resource not found', async () => {
    const harness = startAgent();
    harness.runtime.failures.set('getSession', notFound('sessions/missing'));
    await harness.peer.request('initialize', INITIALIZE);

    const failure = errorOf(await harness.peer.request('session/load', { sessionId: 'missing', cwd: SESSION.cwd, mcpServers: [] }));

    expect(failure).toMatchObject({ code: -32002, data: { sessionId: 'missing' } });
    await harness.peer.close();
  });

  it('refuses to load a session twice on one connection', async () => {
    const harness = startAgent();
    history(harness);
    await harness.peer.request('initialize', INITIALIZE);
    await harness.peer.request('session/load', { sessionId: SESSION.id, cwd: SESSION.cwd, mcpServers: [] });

    const failure = errorOf(await harness.peer.request('session/load', { sessionId: SESSION.id, cwd: SESSION.cwd, mcpServers: [] }));

    expect(failure.code).toBe(-32600);
    await harness.peer.close();
  });

  it('loads a session again on the same connection after its first load failed in the background', async () => {
    const harness = startAgent();
    history(harness);
    await harness.peer.request('initialize', INITIALIZE);
    await harness.peer.request('session/load', { sessionId: SESSION.id, cwd: SESSION.cwd, mcpServers: [] });
    harness.failSessionStream(new Error('the session stream broke'));
    await harness.reported;

    const response = await harness.peer.request('session/load', { sessionId: SESSION.id, cwd: SESSION.cwd, mcpServers: [] });

    expect(resultOf(response)).toMatchObject({ modes: expect.anything() });
    await harness.peer.close();
  });

  it('keeps forwarding the events of a run that is still going after it has answered', async () => {
    const harness = startAgent();
    harness.runtime.runs = [runView({ id: 'run-1', status: 'RUNNING', lastSeq: 2 })];
    const release = Promise.withResolvers<void>();
    harness.scripts.set('run-1', async ({ onEvent }) => {
      onEvent(frameOf('run-1', 1, { type: 'user.message', text: 'Long task' }));
      onEvent(frameOf('run-1', 2, message('m1', 'Working')));
      await release.promise;
      onEvent(frameOf('run-1', 3, { type: 'notice', level: 'warning', message: 'a live notice' }));
      onEvent(frameOf('run-1', 4, message('m2', 'Done')));
      return finishedRun();
    });
    await harness.peer.request('initialize', INITIALIZE);

    await harness.peer.request('session/load', { sessionId: SESSION.id, cwd: SESSION.cwd, mcpServers: [] });
    expect(updatesOf(harness.peer.received).map((update) => update.sessionUpdate)).toEqual(['user_message_chunk', 'agent_message_chunk']);
    release.resolve();
    await harness.peer.untilReceived((received) => updatesOf([received])[0]?.sessionUpdate === 'agent_message_chunk' && JSON.stringify(received).includes('Done'));

    const live = updatesOf(harness.peer.received).slice(2).filter((update) => update.sessionUpdate !== 'available_commands_update');
    expect(live).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'momonga warning: a live notice\n' }, messageId: 'run-1/notice/3' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' }, messageId: 'run-1/m2' },
    ]);
    await harness.peer.close();
  });

  it('fails the load and forgets the session when the replay fails', async () => {
    const harness = startAgent();
    harness.runtime.runs = [runView({ id: 'run-1', status: 'COMPLETED', lastSeq: 2 })];
    harness.scripts.set('run-1', async () => {
      throw new Error('the replay stream broke');
    });
    await harness.peer.request('initialize', INITIALIZE);

    const failure = errorOf(await harness.peer.request('session/load', { sessionId: SESSION.id, cwd: SESSION.cwd, mcpServers: [] }));

    expect(JSON.stringify(failure)).toContain('the replay stream broke');
    expect(errorOf(await prompt(harness, SESSION.id, 'hello')).code).toBe(-32002);
    await harness.peer.close();
  });
});

describe('failures in the background', () => {
  it('reports a failure of a loaded run that nobody awaits and refuses the next prompt of that session with it', async () => {
    const harness = startAgent();
    harness.runtime.runs = [runView({ id: 'run-1', status: 'RUNNING', lastSeq: 1 })];
    const fail = Promise.withResolvers<void>();
    harness.scripts.set('run-1', async ({ onEvent }) => {
      onEvent(frameOf('run-1', 1, { type: 'user.message', text: 'Long task' }));
      await fail.promise;
      throw new Error('the live stream broke');
    });
    await harness.peer.request('initialize', INITIALIZE);
    await harness.peer.request('session/load', { sessionId: SESSION.id, cwd: SESSION.cwd, mcpServers: [] });

    fail.resolve();
    await harness.reported;

    expect(harness.reports.join('\n')).toContain('the live stream broke');
    const failure = errorOf(await prompt(harness, SESSION.id, 'hello'));
    expect(JSON.stringify(failure)).toContain('the live stream broke');
    await harness.peer.close();
  });

  it('reports a failure of the session event stream and refuses the next prompt of that session with it', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);

    harness.failSessionStream(new Error('the session stream broke'));
    await harness.reported;

    expect(harness.reports.join('\n')).toContain('the session stream broke');
    expect(JSON.stringify(errorOf(await prompt(harness, sessionId, 'hello')))).toContain('the session stream broke');
    await harness.peer.close();
  });

  it('aborts the event streams when the connection closes and leaves the run alone', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    harness.scripts.set('run-1', async ({ signal }) => {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      started.resolve();
      await aborted.promise;
      return finishedRun();
    });

    void prompt(harness, sessionId, 'long task');
    await started.promise;
    await harness.peer.close();
    await aborted.promise;

    expect(harness.runtime.calls.some((call) => call.startsWith('cancel'))).toBe(false);
  });
});
