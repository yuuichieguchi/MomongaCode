import { describe, expect, it, vi } from 'vitest';
import type { PlanAccountState } from '@momonga/protocol';
import { KEYS, untilFrame } from './ink-helpers.ts';
import { PLAN_TEST_TIMEOUT_MS, account, choose, eventually, quiet, rowNumberOf, startPlan, submitLine } from './fake-plan-gateway.tsx';
import type { FakePlanBackend } from './fake-plan-gateway.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const NO_MODEL = 'No model is connected. Use /login to connect one.';
const NEEDS_SESSION = 'This command needs a session. Connect a model first with /login.';
const UNCONNECTED_FOOTER = 'no model connected · /login';

const accountsRead = async (backend: FakePlanBackend): Promise<void> => {
  await eventually(() => backend.planCalls.some((call) => call.route === 'accounts'), 'the accounts read');
  await quiet();
};

describe('the welcome screen predicate: no alias and no plan account record in any state', () => {
  it('shows the welcome with Continue with ChatGPT first, then Use an API key and Use a local server, and opens no session', async () => {
    const { app, backend } = await startPlan({ aliases: [], accounts: [] });
    const frame = await untilFrame(app, 'Use a local server');
    expect(rowNumberOf(frame, 'Continue with ChatGPT')).toBe(1);
    expect(rowNumberOf(frame, 'Use an API key')).toBe(2);
    expect(rowNumberOf(frame, 'Use a local server')).toBe(3);
    expect(frame).toContain('esc');
    expect(backend.calls).not.toContain('openSession');
    app.unmount();
  });

  it.each<PlanAccountState>(['needs_sign_in', 'registered', 'store_unreadable', 'plan_disabled'])(
    'keeps the welcome away when an account record exists in state %s and shows the unconnected prompt instead',
    async (state) => {
      const { app, backend } = await startPlan({ aliases: [], accounts: [account({ state, active: false, pinnedBy: [] })] });
      const frame = await untilFrame(app, UNCONNECTED_FOOTER);
      expect(frame).not.toContain('Use a local server');
      expect(backend.calls).not.toContain('openSession');
      app.unmount();
    },
  );

  it('does not show the welcome when an alias exists, even with no account, and opens the session', async () => {
    const { app, backend } = await startPlan({ aliases: ['default'], accounts: [] });
    await backend.called('openSession');
    await accountsRead(backend);
    expect(app.lastFrame()).not.toContain('Use a local server');
    expect(app.lastFrame()).not.toContain(UNCONNECTED_FOOTER);
    app.unmount();
  });

  it('counts a declared target whose health is not ok as connected', async () => {
    const { app, backend } = await startPlan({ aliases: ['default'], accounts: [], health: { primary: { ok: false, breaker: 'open', reason: 'not_running' } } });
    await backend.called('openSession');
    await accountsRead(backend);
    expect(app.lastFrame()).not.toContain('Use a local server');
    app.unmount();
  });

  it('esc on the welcome goes on to the unconnected prompt, not to a failing run', async () => {
    const { app, backend } = await startPlan({ aliases: [], accounts: [] });
    await untilFrame(app, 'Use a local server');
    app.stdin.write(KEYS.escape);
    const frame = await untilFrame(app, UNCONNECTED_FOOTER);
    expect(frame).not.toContain('Use a local server');
    expect(backend.calls).not.toContain('openSession');
    expect(backend.started).toEqual([]);
    app.unmount();
  });
});

describe('the unconnected phase', () => {
  const unconnected = () => startPlan({ aliases: [], accounts: [account({ state: 'needs_sign_in', active: false, pinnedBy: [] })] });

  it('keeps a typed prompt in the editor, starts no run and says how to connect', async () => {
    const { app, backend } = await unconnected();
    await untilFrame(app, UNCONNECTED_FOOTER);
    await submitLine(app, 'refactor the parser');
    const frame = await untilFrame(app, NO_MODEL);
    expect(frame).toContain('> refactor the parser');
    expect(backend.started).toEqual([]);
    expect(backend.calls).not.toContain('openSession');
    app.unmount();
  });

  it('answers a command that needs a session with the needs-session line', async () => {
    const { app } = await unconnected();
    await untilFrame(app, UNCONNECTED_FOOTER);
    await submitLine(app, '/mode');
    await untilFrame(app, NEEDS_SESSION);
    app.unmount();
  });

  it('runs /help without a session', async () => {
    const { app } = await unconnected();
    await untilFrame(app, UNCONNECTED_FOOTER);
    await submitLine(app, '/help');
    const frame = await untilFrame(app, 'Slash commands');
    expect(frame).toContain('/login');
    expect(frame).not.toContain(NEEDS_SESSION);
    app.unmount();
  });
});

describe('local servers from the welcome', () => {
  const ollama = { baseUrl: 'http://127.0.0.1:11434', shape: 'ollama' as const, models: [{ id: 'llama3.2', tools: 'yes' as const }] };

  it('detects on the user action, shows what it found, and writes nothing until a model is chosen', async () => {
    const { app, backend } = await startPlan({ aliases: [], accounts: [], detected: [ollama], trainedContext: { 'llama3.2': 131072 } });
    expect(backend.detections).toEqual([]);
    await choose(app, 'Use a local server');
    const frame = await untilFrame(app, 'http://127.0.0.1:11434');
    expect(frame).toContain('llama3.2');
    expect(backend.detections).toEqual([[]]);
    expect(backend.connections).toEqual([]);
    app.unmount();
  });

  it('asks an Ollama model for its context window with the trained maximum as the ceiling and no default, then writes it and opens the session', async () => {
    const { app, backend } = await startPlan({ aliases: [], accounts: [], detected: [ollama], trainedContext: { 'llama3.2': 131072 } }, { initialPrompt: 'hello there' });
    await choose(app, 'Use a local server');
    await choose(app, 'llama3.2');
    const asked = await untilFrame(app, '131072');
    expect(asked).not.toMatch(/default[^\n]*\d/i);
    app.stdin.write(KEYS.enter);
    await quiet();
    expect(backend.connections).toEqual([]);
    await submitLine(app, '8192');
    await backend.called('openSession');
    expect(backend.connections).toEqual([{ kind: 'server', baseUrl: 'http://127.0.0.1:11434', shape: 'ollama', model: 'llama3.2', contextWindow: 8192 }]);
    await eventually(() => backend.started.length > 0, 'the initial prompt');
    expect(backend.started.map((run) => run.text)).toEqual(['hello there']);
    app.unmount();
  });
});

describe('the invitation banner', () => {
  it('invites a home with an alias and no account, and Not now is remembered as invite:chatgpt', async () => {
    const { app, backend } = await startPlan({ aliases: ['default'], accounts: [] });
    const frame = await untilFrame(app, 'Use your ChatGPT plan in this app.');
    expect(frame).toContain('Continue with ChatGPT');
    expect(frame).toContain('Not now');
    await choose(app, 'Not now');
    await eventually(() => backend.dismissals.length > 0, 'the dismissal');
    expect(backend.dismissals).toEqual(['invite:chatgpt']);
    await quiet();
    expect(app.lastFrame()).not.toContain('Use your ChatGPT plan in this app.');
    app.unmount();
  });

  it('is not shown once dismissed', async () => {
    const { app, backend } = await startPlan({ aliases: ['default'], accounts: [], dismissed: { 'invite:chatgpt': '2026-11-01T00:00:00.000Z' } });
    await backend.called('openSession');
    await accountsRead(backend);
    expect(app.frames.join('\n')).not.toContain('Use your ChatGPT plan in this app.');
    app.unmount();
  });

  it('is not shown to a home that has an account, even a signed-out one', async () => {
    const { app, backend } = await startPlan({ aliases: ['default'], accounts: [account({ state: 'registered', active: false })] });
    await backend.called('openSession');
    await accountsRead(backend);
    expect(app.frames.join('\n')).not.toContain('Use your ChatGPT plan in this app.');
    app.unmount();
  });
});
