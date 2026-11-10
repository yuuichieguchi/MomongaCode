import { describe, expect, it } from 'vitest';
import { createMapperState, mapRunEvent } from '../src/acp/events.ts';
import type { ClientFeatures } from '../src/acp/events.ts';
import { SESSION, runView } from './fake-backend.ts';
import { frameOf, resultOf, startAgent, updatesOf } from './acp-harness.ts';
import type { EventPayload, Harness } from './acp-harness.ts';

const NONE: ClientFeatures = { notices: false, compaction: false, elicitation: { form: false, url: false } };
const INITIALIZE = { protocolVersion: 1, clientCapabilities: { session: { notices: {} } } };
const NEW_SESSION = { cwd: SESSION.cwd, mcpServers: [] };
const OPTIONS = [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' as const }];

const message = (itemId: string, text: string): EventPayload => ({ type: 'agent.message.delta', step: 1, attempt: 0, itemId, text });

const toolCall: EventPayload = { type: 'tool.call', callId: 'call-1', providerCallId: 'call-1', name: 'Edit', kind: 'edit', title: 'Edit a.txt', rawInput: { file_path: '/a.txt' } };

const open = async (harness: Harness): Promise<string> => {
  await harness.peer.request('initialize', INITIALIZE);
  return (resultOf(await harness.peer.request('session/new', NEW_SESSION)) as { sessionId: string }).sessionId;
};

const prompt = (harness: Harness, sessionId: string, text: string) => harness.peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });

describe('the prompt of a run in the ACP history (16.2, red test 4)', () => {
  it('maps only the first event of the run to the user chunk; hook context and stop-hook feedback are not the user\'s words', () => {
    const state = createMapperState();
    const mapped = [
      frameOf('run-1', 1, { type: 'user.message', text: 'Do it' }),
      frameOf('run-1', 2, { type: 'user.message', text: '[hook UserPromptSubmit] context' }),
      frameOf('run-1', 3, { type: 'agent.message.delta', step: 1, attempt: 0, itemId: 'm1', text: 'Done' }),
      frameOf('run-1', 4, { type: 'user.message', text: '[hook Stop] keep going' }),
    ].flatMap((frame) => mapRunEvent(frame.data, 'history', state, NONE));
    expect(mapped.flatMap((effect) => (effect.kind === 'update' && effect.update.sessionUpdate === 'user_message_chunk' ? [effect.update.content] : []))).toEqual([{ type: 'text', text: 'Do it' }]);
  });
});

describe('the quiet point of the ACP bridge (16.5, red test 12)', () => {
  it('is not quiet before initialize, and is quiet with an idle session', async () => {
    const harness = startAgent();
    expect(harness.bridge.quiet()).toBe(false);
    await open(harness);
    expect(harness.bridge.quiet()).toBe(true);
    await harness.peer.close();
  });

  it('is not quiet while a session/prompt is in flight, and is quiet again when it is answered', async () => {
    const harness = startAgent();
    const activity: boolean[] = [];
    harness.bridge.onActivity(() => activity.push(harness.bridge.quiet()));
    const sessionId = await open(harness);
    const finish = Promise.withResolvers<void>();
    harness.scripts.set('run-1', async (request) => {
      request.onEvent(frameOf('run-1', 1, message('m1', 'Hi')));
      await finish.promise;
      return runView({ id: 'run-1', status: 'COMPLETED' });
    });
    const answered = prompt(harness, sessionId, 'hello');
    await harness.runtime.called('createRun');
    expect(harness.bridge.quiet()).toBe(false);
    finish.resolve();
    await answered;
    expect(harness.bridge.quiet()).toBe(true);
    expect(activity.at(-1)).toBe(true);
    await harness.peer.close();
  });

  it('is not quiet while a request of the agent awaits the editor', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    const answer = Promise.withResolvers<unknown>();
    const asked = Promise.withResolvers<void>();
    harness.peer.answerRequests(() => {
      asked.resolve();
      return answer.promise;
    });
    harness.runtime.runs = [runView({ id: 'run-1', status: 'WAITING_HUMAN', lastSeq: 0 })];
    harness.scripts.set('run-1', async (request) => {
      request.onEvent(frameOf('run-1', 1, toolCall));
      request.onEvent(frameOf('run-1', 2, { type: 'tool.permission.requested', approvalId: 'approval-1', callId: 'call-1', subjectDigest: 'd', reason: 'edits require approval', options: OPTIONS }));
      return new Promise(() => undefined);
    });
    void prompt(harness, sessionId, 'hello');
    await asked.promise;
    expect(harness.bridge.quiet()).toBe(false);
    answer.resolve({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    await harness.runtime.called('resolveApproval');
    await harness.peer.close();
  });
});

describe('the ACP bridge across the move (16.7, red test 13)', () => {
  it('records the initialize request, the sessions and the last event of each run', async () => {
    const harness = startAgent();
    const sessionId = await open(harness);
    harness.scripts.set('run-1', async (request) => {
      request.onEvent(frameOf('run-1', 1, message('m1', 'Hi')));
      request.onEvent(frameOf('run-1', 2, message('m1', ' there')));
      return runView({ id: 'run-1', status: 'COMPLETED' });
    });
    await prompt(harness, sessionId, 'hello');
    expect(harness.bridge.snapshot()).toMatchObject({ initialize: INITIALIZE, sessions: [sessionId], lastSeq: { 'run-1': 2 } });
    await harness.peer.close();
  });

  it('replays the recorded initialize to itself, restores the session map, and sends the editor nothing it has already seen', async () => {
    const harness = startAgent({}, INITIALIZE);
    harness.runtime.runs = [runView({ id: 'run-1', status: 'COMPLETED', lastSeq: 2 }), runView({ id: 'run-2', status: 'RUNNING', lastSeq: 2 })];
    const live = Promise.withResolvers<void>();
    harness.scripts.set('run-2', async (request) => {
      request.onEvent(frameOf('run-2', 1, { type: 'user.message', text: 'second' }));
      request.onEvent(frameOf('run-2', 2, message('m2', 'seen before the move')));
      await live.promise;
      request.onEvent(frameOf('run-2', 3, message('m2', ' and after it')));
      return runView({ id: 'run-2', status: 'COMPLETED', lastSeq: 3 });
    });

    await harness.bridge.adopt({ sessions: [SESSION.id], lastSeq: { 'run-1': 2, 'run-2': 2 } });

    expect(harness.peer.received).toEqual([]);
    expect(harness.runtime.calls).toContain(`getSession ${SESSION.id}`);
    expect(harness.bridge.snapshot()).toMatchObject({ initialize: INITIALIZE, sessions: [SESSION.id], lastSeq: { 'run-1': 2, 'run-2': 2 } });
    live.resolve();
    await harness.peer.untilReceived((received) => updatesOf([received]).length > 0);
    expect(updatesOf(harness.peer.received).map((update) => update['content'])).toEqual([{ type: 'text', text: ' and after it' }]);

    harness.scripts.set('run-1', async () => runView({ id: 'run-1', status: 'COMPLETED' }));
    harness.runtime.createRunResult = async () => runView({ id: 'run-1', status: 'QUEUED' });
    expect(resultOf(await prompt(harness, SESSION.id, 'next'))).toEqual({ stopReason: 'end_turn' });
    await harness.peer.close();
  });
});
