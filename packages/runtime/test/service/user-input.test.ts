import { describe, expect, it } from 'vitest';
import type { AttachTerms, UserInputPort } from '@momonga/runtime';
import { textStep } from '../worker/scripts.ts';
import { outputReserveFor } from '@momonga/protocol';
import { attachWorkerKit, defaultModelCapabilities, expectError, expectSchema, startService } from './helpers.ts';
import type { JsonResponse, ServiceEnv } from './helpers.ts';

type Frame = { type: string; text?: string; reason?: string; record?: { command: string; exitCode: number | null; output: string; include: boolean } };

const framesOf = (response: JsonResponse): Frame[] =>
  response.text
    .split('\n\n')
    .flatMap((block) => block.split('\n').filter((line) => line.startsWith('data: ')))
    .map((line) => JSON.parse(line.slice('data: '.length)) as Frame);

const userInputsOf = (body: { input?: unknown }): string[] =>
  (Array.isArray(body.input) ? body.input : []).flatMap((item: { type?: string; role?: string; content?: unknown }) =>
    item.type === 'message' && item.role === 'user' ? [JSON.stringify(item.content)] : [],
  );

const echoShell: UserInputPort['shell'] = async (_session, command, io) => {
  io.onOutput(`ran ${command}\n`);
  return { kind: 'ran', exitCode: 0, output: `ran ${command}` };
};

const unusedAttach: UserInputPort['attach'] = () => Promise.reject(new Error('no file is attached in this test'));

const shellOf = (env: ServiceEnv, sessionId: string, command: string, include: boolean): Promise<JsonResponse> =>
  env.http('POST', `/v1/sessions/${sessionId}/user-shell`, { body: { command, include } });

describe('a command the person typed (design 5.9)', () => {
  it('streams the output, ends with the stored record, and lists it until the next run carries it', async () => {
    const env = await startService({ userInput: { attach: unusedAttach, shell: echoShell } });
    const session = await env.createSession();

    const response = await shellOf(env, session.id, 'ls', true);

    expect(response.status).toBe(200);
    const frames = framesOf(response);
    for (const frame of frames) expectSchema('UserShellFrame', frame);
    expect(frames).toEqual([
      { type: 'output', text: 'ran ls\n' },
      { type: 'exit', record: { command: 'ls', exitCode: 0, output: 'ran ls', include: true } },
    ]);
    const pending = await env.http('GET', `/v1/sessions/${session.id}/user-shell`);
    expectSchema('UserShellPendingResponse', pending.json);
    expect(pending.json.pending).toEqual([{ command: 'ls', exitCode: 0, output: 'ran ls', include: true }]);
    expect(env.store.readSessionEvents(session.id, 0, 100).filter((event) => event.type === 'user_shell')).toHaveLength(1);
  });

  it('gives the model the output of ! with the next message and never the output of !!', async () => {
    const env = await startService({ userInput: { attach: unusedAttach, shell: echoShell } });
    const kit = attachWorkerKit(env);
    const session = await env.createSession();
    await shellOf(env, session.id, 'make test', true);
    await shellOf(env, session.id, 'cat secret-notes', false);
    kit.gateway.script.push(textStep('Seen.'));

    const run = await env.createRun(session.id, { input: 'why does it fail' });
    expect(await kit.runOnce(kit.worker())).toBe('yielded');

    const [prompt] = env.ofType(run.id, 'user.message');
    expect(prompt?.shell).toEqual([
      { command: 'make test', exitCode: 0, output: 'ran make test', include: true },
      { command: 'cat secret-notes', exitCode: 0, output: 'ran cat secret-notes', include: false },
    ]);
    const sent = userInputsOf(kit.gateway.streams[0]?.body ?? {}).join('\n');
    expect(sent).toMatch(/<user_shell_command command=\\"make test\\" exit_code=\\"0\\" boundary=\\"([0-9a-f]{32})\\">\\nran make test\\n<\/user_shell_command boundary=\\"\1\\">/);
    expect(sent).not.toContain('secret-notes');
    expect(sent.indexOf('user_shell_command')).toBeLessThan(sent.indexOf('why does it fail'));
    expect((await env.http('GET', `/v1/sessions/${session.id}/user-shell`)).json.pending).toEqual([]);
  });

  it('carries a record into one run only', async () => {
    const env = await startService({ userInput: { attach: unusedAttach, shell: echoShell } });
    const kit = attachWorkerKit(env);
    const session = await env.createSession();
    await shellOf(env, session.id, 'ls', true);
    kit.gateway.script.push(textStep('One.'), textStep('Two.'));
    const first = await env.createRun(session.id, { input: 'first' });
    expect(await kit.runOnce(kit.worker())).toBe('yielded');
    const second = await env.createRun(session.id, { input: 'second' });

    expect(env.ofType(first.id, 'user.message')[0]?.shell).toHaveLength(1);
    expect(env.ofType(second.id, 'user.message')[0]?.shell).toBeUndefined();
  });

  it('does not start while a run of the session works', async () => {
    let started = 0;
    const env = await startService({
      userInput: {
        attach: unusedAttach,
        shell: (session, command, io) => {
          started += 1;
          return echoShell(session, command, io);
        },
      },
    });
    const session = await env.createSession();
    await env.createRun(session.id);

    expectError(await shellOf(env, session.id, 'ls', true), 409, 'run_active');
    expect(started).toBe(0);
  });

  it('tells, before the output, that the command runs without the protection of the home, with the sentence that names how to get it', async () => {
    const reason = 'With sandbox none, commands can read and change the home, because bubblewrap is not installed: install bubblewrap (bwrap) to protect it.';
    const shell: UserInputPort['shell'] = async (_session, command, io) => {
      io.onUnprotected(reason);
      io.onOutput(`ran ${command}\n`);
      return { kind: 'ran', exitCode: 0, output: `ran ${command}` };
    };
    const env = await startService({ userInput: { attach: unusedAttach, shell } });
    const session = await env.createSession();
    const frames = framesOf(await shellOf(env, session.id, 'ls', true));
    expect(frames.map((frame) => frame.type)).toEqual(['unprotected', 'output', 'exit']);
    expect(frames[0]).toEqual({ type: 'unprotected', reason });
  });

  it('tells a refused command with its reason and stores nothing', async () => {
    const env = await startService({ userInput: { attach: unusedAttach, shell: async () => ({ kind: 'refused', reason: 'denied by rule Bash(rm:*)' }) } });
    const session = await env.createSession();

    expect(framesOf(await shellOf(env, session.id, 'rm -rf x', true))).toEqual([{ type: 'refused', reason: 'denied by rule Bash(rm:*)' }]);
    expect((await env.http('GET', `/v1/sessions/${session.id}/user-shell`)).json.pending).toEqual([]);
  });

  it('stops the running command when the person interrupts it and keeps its record', async () => {
    let running!: () => void;
    const begun = new Promise<void>((resolve) => {
      running = resolve;
    });
    const env = await startService({
      userInput: {
        attach: unusedAttach,
        shell: (_session, _command, io) =>
          new Promise((resolve) => {
            io.signal.addEventListener('abort', () => resolve({ kind: 'ran', exitCode: null, output: '[terminated by SIGTERM]' }), { once: true });
            running();
          }),
      },
    });
    const session = await env.createSession();
    const answer = shellOf(env, session.id, 'sleep 600', false);
    await begun;

    expectError(await shellOf(env, session.id, 'ls', true), 409, 'user_shell_running');
    const stopped = await env.http('DELETE', `/v1/sessions/${session.id}/user-shell`);

    expect(stopped.json).toEqual({ stopped: true });
    expect(framesOf(await answer)).toEqual([{ type: 'exit', record: { command: 'sleep 600', exitCode: null, output: '[terminated by SIGTERM]', include: false } }]);
    expect((await env.http('DELETE', `/v1/sessions/${session.id}/user-shell`)).json).toEqual({ stopped: false });
  });

  it('answers 404 for an unknown session and 400 for a body outside the schema', async () => {
    const env = await startService({ userInput: { attach: unusedAttach, shell: echoShell } });
    const session = await env.createSession();
    expectError(await shellOf(env, 'nope', 'ls', true), 404, 'not_found');
    expectError(await env.http('POST', `/v1/sessions/${session.id}/user-shell`, { body: { command: '', include: true } }), 400, 'invalid_request');
    expectError(await env.http('POST', `/v1/sessions/${session.id}/user-shell`, { body: { command: 'ls' } }), 400, 'invalid_request');
  });
});

describe('files named with @ in a message (design 5.8)', () => {
  const attachingService = (seen: { text: string; terms: AttachTerms }[]) =>
    startService({
      userInput: {
        shell: echoShell,
        attach: async (_session, text, terms) => {
          seen.push({ text, terms });
          return {
            attachments: [
              { type: 'attached_file', path: 'src/app.tsx', content: '     1\tfirst\n     2\tsecond', truncated: false },
              { type: 'attachment_note', path: '.env', text: 'The user referenced .env, which cannot be attached (denied by a rule). Do not try to read it unless asked.', shown: '.env: not attached (denied by a rule)' },
            ],
            images: [],
          };
        },
      },
    });

  it('stores the attached parts with the message and sends them to the model after the text', async () => {
    const seen: { text: string; terms: AttachTerms }[] = [];
    const env = await attachingService(seen);
    const kit = attachWorkerKit(env);
    const session = await env.createSession();
    kit.gateway.script.push(textStep('Read.'));

    const run = await env.createRun(session.id, { input: 'explain @src/app.tsx and @.env', attachMentions: true });
    expect(await kit.runOnce(kit.worker())).toBe('yielded');

    expect(seen.map((call) => call.text)).toEqual(['explain @src/app.tsx and @.env']);
    const capabilities = defaultModelCapabilities();
    expect(seen[0]?.terms).toMatchObject({ ceiling: capabilities.contextWindow - outputReserveFor(capabilities), imageInput: false });
    expect(env.ofType(run.id, 'user.message')[0]).toMatchObject({ text: 'explain @src/app.tsx and @.env', attachments: [{ type: 'attached_file', path: 'src/app.tsx' }, { type: 'attachment_note', path: '.env' }] });
    const sent = userInputsOf(kit.gateway.streams[0]?.body ?? {}).join('\n');
    expect(sent).toMatch(/<attached_file path=\\"src\/app.tsx\\" boundary=\\"([0-9a-f]{32})\\">\\n     1\\tfirst\\n     2\\tsecond\\n<\/attached_file boundary=\\"\1\\">/);
    expect(sent).toContain('The user referenced .env, which cannot be attached (denied by a rule). Do not try to read it unless asked.');
    expect(sent.indexOf('explain @src/app.tsx')).toBeLessThan(sent.indexOf('attached_file'));
  });

  it('leaves the text alone when the client did not ask for attachments or the text names no file', async () => {
    const seen: { text: string; terms: AttachTerms }[] = [];
    const env = await attachingService(seen);
    const session = await env.createSession();

    const plain = await env.createRun(session.id, { input: 'explain @src/app.tsx' });
    const second = await startService({ userInput: { shell: echoShell, attach: unusedAttach } });
    const other = await second.createSession();
    const none = await second.createRun(other.id, { input: 'no file here', attachMentions: true });

    expect(seen).toEqual([]);
    expect(env.ofType(plain.id, 'user.message')[0]?.attachments).toBeUndefined();
    expect(second.ofType(none.id, 'user.message')[0]?.attachments).toBeUndefined();
  });
});
