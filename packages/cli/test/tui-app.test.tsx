import { describe, expect, it } from 'vitest';
import { createSlashRegistry, BUILTIN_SLASH_COMMANDS } from '../src/tui/slash.ts';
import { App } from '../src/tui/app.tsx';
import { fakeBackend, runView } from './fake-backend.ts';
import { KEYS, renderObservable, untilFrame, untilOutput } from './ink-helpers.ts';
import { frame, runStarted, start, type } from './tui-harness.tsx';

describe('App startup', () => {
  it('opens the session of a trusted folder and shows the status line', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: default (shift+tab)');
    expect(backend.calls).toEqual(['boot', 'openSession']);
    app.unmount();
  });

  it('asks for trust in an unknown folder and records the choice', async () => {
    const { backend, app } = await start({ trust: { path: '/work/project', decision: null } });
    await untilFrame(app, 'Do you trust the files in /work/project?');
    expect(backend.calls).toEqual(['boot']);
    app.stdin.write('1');
    await untilFrame(app, 'mode: default');
    expect(backend.calls).toEqual(['boot', 'trust:trusted', 'openSession']);
    app.unmount();
  });

  it('records an untrusted choice and still opens the session', async () => {
    const { backend, app } = await start({ trust: { path: '/work/project', decision: null } });
    await untilFrame(app, 'Do you trust');
    app.stdin.write('2');
    await untilFrame(app, 'mode: default');
    expect(backend.calls).toEqual(['boot', 'trust:untrusted', 'openSession']);
    app.unmount();
  });

  it('exits without a decision when the trust prompt is dismissed', async () => {
    const { backend, app, exited } = await start({ trust: { path: '/work/project', decision: null } });
    await untilFrame(app, 'Do you trust');
    app.stdin.write(KEYS.ctrlC);
    expect(await exited).toEqual({});
    expect(backend.calls).toEqual(['boot']);
  });

  it('sends an initial prompt once the session is ready', async () => {
    const { backend, app } = await start({}, { initialPrompt: 'list the files' });
    await untilOutput(app, '> list the files');
    expect(backend.started).toEqual([{ text: 'list the files', history: 'inherit' }]);
    app.unmount();
  });
});

describe('App run rendering', () => {
  it('streams assistant text, shows tool calls with their status and reports usage and context', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: default');
    await runStarted(backend, app, 'what is here');
    backend.emit(frame({ type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'Looking' }));
    await untilFrame(app, 'Looking');
    backend.emit(frame({ type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: ' around.' }));
    await untilFrame(app, 'Looking around.');
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Glob', kind: 'search', title: 'Glob *.ts', rawInput: {} }));
    await untilFrame(app, '· Glob *.ts');
    backend.emit(frame({ type: 'tool.started', callId: 'c1', idemKey: 'k' }));
    await untilFrame(app, '… Glob *.ts');
    backend.emit(frame({ type: 'tool.completed', callId: 'c1', status: 'completed', output: 'a.ts' }));
    await untilOutput(app, '✓ Glob *.ts');
    backend.emit(frame({ type: 'model.responded', attempt: 0, response: { status: 'completed', output: [], usage: { input_tokens: 1500, output_tokens: 100, total_tokens: 1600 } } }));
    backend.emit(frame({ type: 'usage.updated', inputTokens: 1500, outputTokens: 100, totalTokens: 1600 }));
    await untilFrame(app, 'tokens: 1.6k · context: 20%');
    backend.emit(frame({ type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }));
    backend.finish(runView());
    await untilFrame(app, /mode: default \(shift\+tab\) · tokens: 1\.6k · context: 20%$/m);
    app.unmount();
  });

  it('reports a failed run with its reason', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: default');
    await runStarted(backend, app, 'go');
    backend.finish(runView({ status: 'FAILED', error: { code: 'provider_unavailable', message: 'run `sudo fm license`' } }));
    await untilOutput(app, 'provider_unavailable: run `sudo fm license`');
    app.unmount();
  });

  it('shows the permission prompt with a diff for Edit and resolves the chosen option', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: default');
    await runStarted(backend, app, 'edit it');
    backend.emit(
      frame({
        type: 'tool.call',
        callId: 'c1',
        providerCallId: 'p1',
        name: 'Edit',
        kind: 'edit',
        title: 'Edit /work/project/a.toml',
        rawInput: { file_path: '/work/project/a.toml', old_string: 'name = "old"', new_string: 'name = "new"' },
      }),
    );
    backend.emit(
      frame({
        type: 'tool.permission.requested',
        approvalId: 'ap1',
        callId: 'c1',
        subjectDigest: 'd',
        options: [
          { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'o2', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'o3', name: 'Reject once', kind: 'reject_once' },
          { optionId: 'o4', name: 'Always reject', kind: 'reject_always' },
        ],
      }),
    );
    const prompt = await untilFrame(app, 'Permission requested: Edit /work/project/a.toml');
    expect(prompt).toContain('- name = "old"');
    expect(prompt).toContain('+ name = "new"');
    for (const label of ['1. Allow once', '2. Always allow', '3. Reject once', '4. Always reject']) expect(prompt).toContain(label);
    app.stdin.write('2');
    await backend.called('approve:ap1:o2');
    app.unmount();
  });

  it('confirms the highlighted option with enter after moving with the arrow keys', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: default');
    await runStarted(backend, app, 'x');
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash ls', rawInput: { command: 'ls' } }));
    backend.emit(
      frame({
        type: 'tool.permission.requested',
        approvalId: 'ap1',
        callId: 'c1',
        subjectDigest: 'd',
        options: [
          { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'o3', name: 'Reject once', kind: 'reject_once' },
        ],
      }),
    );
    await untilFrame(app, 'Permission requested: Bash ls');
    app.stdin.write(KEYS.down);
    app.stdin.write(KEYS.enter);
    await backend.called('approve:ap1:o3');
    app.unmount();
  });

  it('cancels the run on escape, also while a permission prompt is open', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: default');
    await runStarted(backend, app, 'long task');
    await untilFrame(app, 'working (esc to cancel)');
    app.stdin.write(KEYS.escape);
    await backend.called('cancel:run-1');
    app.unmount();
  });
});

describe('App input', () => {
  it('cycles the permission modes with shift+tab and never offers bypassPermissions to a session that may not use it', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: default');
    app.stdin.write(KEYS.shiftTab);
    await untilFrame(app, 'mode: acceptEdits');
    app.stdin.write(KEYS.shiftTab);
    await untilFrame(app, 'mode: plan');
    app.stdin.write(KEYS.shiftTab);
    await untilFrame(app, 'mode: default');
    expect(backend.calls.filter((call) => call.startsWith('mode:'))).toEqual(['mode:acceptEdits', 'mode:plan', 'mode:default']);
    app.unmount();
  });

  it('includes bypassPermissions in the cycle when the session may use it', async () => {
    const { backend, app } = await start({ session: { permissionMode: 'plan', bypassAllowed: true } });
    await untilFrame(app, 'mode: plan');
    app.stdin.write(KEYS.shiftTab);
    await untilFrame(app, 'mode: bypassPermissions');
    expect(backend.calls).toContain('mode:bypassPermissions');
    app.unmount();
  });

  it('keeps a multi-line message together: backslash enter and ctrl+j add lines, enter submits all of it', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: default');
    await type(app, 'first\\', 'first\\');
    app.stdin.write(KEYS.enter);
    app.stdin.write('second');
    app.stdin.write(KEYS.ctrlJ);
    app.stdin.write('third');
    await untilFrame(app, 'third');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, '> first');
    expect(backend.started).toEqual([{ text: 'first\nsecond\nthird', history: 'inherit' }]);
    app.unmount();
  });

  it('recalls earlier messages with the up arrow', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: default');
    await runStarted(backend, app, 'one');
    backend.finish(runView());
    await untilFrame(app, /mode: default \(shift\+tab\) · tokens: 0$/m);
    app.stdin.write(KEYS.up);
    await untilFrame(app, '> one');
    app.unmount();
  });

  it('starts with the history of earlier sessions and records every submission', async () => {
    const { backend, app } = await start({ history: ['from yesterday'] });
    await untilFrame(app, 'mode: default');
    app.stdin.write(KEYS.up);
    await untilFrame(app, '> from yesterday');
    app.stdin.write(KEYS.ctrlC);
    await type(app, '/help', '> /help');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, 'Slash commands');
    expect(backend.recorded).toEqual(['/help']);
    app.unmount();
  });

  it('refuses a second message while a run is active and says how to cancel', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: default');
    await runStarted(backend, app, 'one');
    await type(app, 'two', '> two');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, 'a task is running; press esc to cancel it');
    expect(backend.started).toHaveLength(1);
    app.unmount();
  });
});

describe('App slash commands', () => {
  it('/help lists the commands', async () => {
    const { app } = await start();
    await untilFrame(app, 'mode: default');
    await type(app, '/help', '> /help');
    app.stdin.write(KEYS.enter);
    const output = await untilOutput(app, 'Slash commands');
    for (const name of ['/help', '/clear', '/mode', '/exit']) expect(output).toContain(name);
    app.unmount();
  });

  it('/mode sets the permission mode and rejects an unknown one', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: default');
    await type(app, '/mode plan', '> /mode plan');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'mode: plan');
    expect(backend.calls).toContain('mode:plan');
    await type(app, '/mode nonsense', '> /mode nonsense');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, 'unknown permission mode nonsense');
    app.unmount();
  });

  it('/clear starts a fresh conversation for the next run', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: default');
    await type(app, '/clear', '> /clear');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, /mode: default \(shift\+tab\) · tokens: 0$/m);
    await type(app, 'again', '> again');
    app.stdin.write(KEYS.enter);
    await backend.called('openSession');
    await untilOutput(app, '> again');
    expect(backend.started).toEqual([{ text: 'again', history: 'fresh' }]);
    app.unmount();
  });

  it('/exit leaves the application', async () => {
    const { app, exited } = await start();
    await untilFrame(app, 'mode: default');
    await type(app, '/exit', '> /exit');
    app.stdin.write(KEYS.enter);
    expect(await exited).toEqual({});
  });

  it('ctrl+d leaves the application when the input is empty', async () => {
    const { app, exited } = await start();
    await untilFrame(app, 'mode: default');
    app.stdin.write(KEYS.ctrlD);
    expect(await exited).toEqual({});
  });

  it('an unknown command is reported and not sent to the model', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: default');
    await type(app, '/frobnicate', '> /frobnicate');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, 'unknown command /frobnicate; /help lists the commands');
    expect(backend.started).toEqual([]);
    app.unmount();
  });

  it('commands from another registry are dispatched, which is where /skill-name plugs in', async () => {
    const seen: string[] = [];
    const registry = createSlashRegistry([
      ...BUILTIN_SLASH_COMMANDS,
      { name: 'review', description: 'review the diff', run: (args) => void seen.push(args) },
    ]);
    const backend = fakeBackend();
    const app = renderObservable(<App backend={backend} initialMode={undefined} slash={registry} onExit={() => undefined} />);
    await untilFrame(app, 'mode: default');
    await type(app, '/review main', '> /review main');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'mode: default');
    expect(seen).toEqual(['main']);
    app.unmount();
  });
});
