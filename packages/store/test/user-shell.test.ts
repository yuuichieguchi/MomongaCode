import { describe, expect, it } from 'vitest';
import type { MessageAttachment, UserShellRecord } from '@momonga/protocol';
import { decodeEvent } from '../src/codec.ts';
import { foldRunState, initialRunState } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { TIMEOUT_MS, enqueue, harness, newSession } from './helpers.ts';

const INCLUDED: UserShellRecord = { command: 'make test', exitCode: 2, output: 'FAIL src/a.test.ts', include: true };
const KEPT_OUT: UserShellRecord = { command: 'cat notes.txt', exitCode: 0, output: 'private', include: false };
const INTERRUPTED: UserShellRecord = { command: 'sleep 600', exitCode: null, output: '[terminated by SIGTERM]', include: true };

const historyOf = (store: RuntimeStore, runId: string) => store.readRunEvents(runId, 0, 100).reduce(foldRunState, initialRunState({ runId, sessionId: 's' })).history;

const sessionRow = (payload: Record<string, unknown> & { type: string }) => ({
  id: 7,
  run_id: null,
  session_id: 's1',
  seq: null,
  step: null,
  lease_token: null,
  created_at: 5,
  type: payload['type'],
  payload_json: JSON.stringify(payload),
});

describe('the user_shell event', () => {
  it('goes through the codec both ways with its command, exit code, output and include flag', () => {
    const { store } = harness();
    const session = newSession(store);

    expect(store.userShell.record(session.id, INCLUDED)).toEqual({ kind: 'recorded' });
    expect(store.userShell.record(session.id, INTERRUPTED)).toEqual({ kind: 'recorded' });

    const events = store.readSessionEvents(session.id, 0, 100).filter((event) => event.type === 'user_shell');
    expect(events).toEqual([
      { type: 'user_shell', ...INCLUDED, id: expect.any(Number), sessionId: session.id, createdAt: expect.any(Number) },
      { type: 'user_shell', ...INTERRUPTED, id: expect.any(Number), sessionId: session.id, createdAt: expect.any(Number) },
    ]);
  });

  it('decodes a stored row and refuses one that lacks a field', () => {
    expect(decodeEvent(sessionRow({ type: 'user_shell', ...KEPT_OUT }))).toEqual({ type: 'user_shell', ...KEPT_OUT, id: 7, sessionId: 's1', createdAt: 5 });
    expect(() => decodeEvent(sessionRow({ type: 'user_shell', command: 'ls', exitCode: 0, output: 'x' }))).toThrow(/user_shell must hold command, exitCode, output and include/);
    expect(() => decodeEvent(sessionRow({ type: 'user_shell', command: 'ls', exitCode: 'zero', output: 'x', include: true }))).toThrow(/user_shell must hold/);
  });

  it('answers not_found for a session that does not exist', () => {
    const { store } = harness();
    expect(store.userShell.record('nope', INCLUDED)).toEqual({ kind: 'not_found' });
  });

  it('waits for the next run of the session, which carries both kinds in the order typed', async () => {
    const { store } = harness();
    const session = newSession(store);
    const other = newSession(store, '/work/b');
    store.userShell.record(session.id, INCLUDED);
    store.userShell.record(session.id, KEPT_OUT);
    store.userShell.record(other.id, INTERRUPTED);

    expect(store.userShell.pending(session.id)).toEqual([INCLUDED, KEPT_OUT]);

    const run = await enqueue(store, session.id, 'why does it fail');
    const [prompt] = store.readRunEvents(run.id, 0, 10);
    expect(prompt).toMatchObject({ type: 'user.message', text: 'why does it fail', shell: [INCLUDED, KEPT_OUT] });
    expect(store.userShell.pending(session.id)).toEqual([]);
    expect(store.userShell.pending(other.id)).toEqual([INTERRUPTED]);
  });

  it('gives the model the included output with the message and keeps the other out of the history', async () => {
    const { store } = harness();
    const session = newSession(store);
    store.userShell.record(session.id, INCLUDED);
    store.userShell.record(session.id, KEPT_OUT);
    const run = await enqueue(store, session.id, 'why does it fail');

    const [first] = historyOf(store, run.id);
    expect(first?.item).toEqual({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '<user_shell_command><command>make test</command><exit_code>2</exit_code><output>FAIL src/a.test.ts</output></user_shell_command>' },
        { type: 'input_text', text: 'why does it fail' },
      ],
    });
  });

  it('tells whether a run of the session is open', async () => {
    const { store } = harness();
    const session = newSession(store);
    expect(store.userShell.runActive(session.id)).toBe(false);
    await enqueue(store, session.id);
    expect(store.userShell.runActive(session.id)).toBe(true);
  });
});

describe('files attached to a user message', () => {
  it('are stored with the message and reach the history after the text', async () => {
    const { store } = harness();
    const session = newSession(store);
    const attachments: MessageAttachment[] = [{ type: 'attached_file', path: 'a.ts', content: '     1\tx', truncated: false }];
    const created = await store.createRunAndEnqueue(session.id, { input: 'read @a.ts', timeoutMs: TIMEOUT_MS, limits: { maxSteps: 10 }, pins: { model: 'fm' }, attachments });
    if (created.kind !== 'created') throw new Error(`expected a run, got ${created.kind}`);

    expect(store.readRunEvents(created.run.id, 0, 10)[0]).toMatchObject({ type: 'user.message', attachments });
    expect(historyOf(store, created.run.id)[0]?.item).toEqual({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'read @a.ts' },
        { type: 'input_text', text: '<attached_file path="a.ts">\n     1\tx\n</attached_file>' },
      ],
    });
  });
});
