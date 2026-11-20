import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { LocalServerDetection, PlanAccountState } from '@momonga/protocol';
import { SESSION } from './fake-backend.ts';
import { KEYS, untilFrame, untilOutput } from './ink-helpers.ts';
import type { Instance } from './ink-helpers.ts';
import { LISTENER_PORT, PLAN_TEST_TIMEOUT_MS, account, choose, eventually, rowNumberOf, startPlan, submitLine, untilRow, untilPromptDrawn, untilTypedAfter } from './fake-plan-gateway.tsx';
import type { FakePlanBackend } from './fake-plan-gateway.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const DESCRIPTION = 'Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.';
const PASTE_LABEL = 'On a remote machine? Paste the redirect URL here';
const NO_MODEL = 'No model is connected. Use /login to sign in or add an API key, or /model to use a local server.';
const NEEDS_SESSION = 'This command needs a session. Connect a model first with /login.';
const UNCONNECTED_FOOTER = 'no model connected · /login';

const sessionShown = async (app: Instance): Promise<void> => {
  await untilFrame(app, 'mode: manual');
};

describe('the welcome screen predicate: no model and no plan account record in any state', () => {
  it('shows the welcome with Continue with ChatGPT first, then Use an API key and Use a local server, and opens no session', async () => {
    const { app, backend } = await startPlan({ models: [], accounts: [] });
    const frame = await untilFrame(app, (shown) => shown.includes('Use a local server') && shown.includes('esc'));
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
      const { app, backend } = await startPlan({ models: [], accounts: [account({ state, active: false, pinnedBy: [] })] });
      const frame = await untilFrame(app, UNCONNECTED_FOOTER);
      expect(frame).not.toContain('Use a local server');
      expect(backend.calls).not.toContain('openSession');
      app.unmount();
    },
  );

  it('does not show the welcome when a model exists, even with no account, and opens the session', async () => {
    const { app, backend } = await startPlan({ accounts: [] });
    await backend.called('openSession');
    await sessionShown(app);
    expect(app.lastFrame()).not.toContain('Use a local server');
    expect(app.lastFrame()).not.toContain(UNCONNECTED_FOOTER);
    app.unmount();
  });

  it('counts a configured model whose health is not ok as connected', async () => {
    const { app, backend } = await startPlan({ accounts: [], health: { [SESSION.model]: { ok: false, breaker: 'open', reason: 'not_running' } } });
    await backend.called('openSession');
    await sessionShown(app);
    expect(app.lastFrame()).not.toContain('Use a local server');
    app.unmount();
  });

  it('esc on the welcome goes on to the unconnected prompt, not to a failing run', async () => {
    const { app, backend } = await startPlan({ models: [], accounts: [] });
    await untilFrame(app, 'Use a local server');
    app.stdin.write(KEYS.escape);
    const frame = await untilFrame(app, UNCONNECTED_FOOTER);
    expect(frame).not.toContain('Use a local server');
    expect(backend.calls).not.toContain('openSession');
    expect(backend.started).toEqual([]);
    app.unmount();
  });
});

describe('the welcome actions', () => {
  it('Continue with ChatGPT shows the description under the row and signs in at once with the first free label, with no second list', async () => {
    const { app, backend } = await startPlan({ models: [], accounts: [], callbackArrives: false });
    const welcome = await untilRow(app, 'Continue with ChatGPT');
    expect(welcome.replace(/\s+/g, ' ')).toContain(DESCRIPTION);
    await choose(app, 'Continue with ChatGPT');
    const waiting = await untilFrame(app, PASTE_LABEL);
    expect(waiting.replace(/\s+/g, ' ')).toContain(DESCRIPTION);
    expect(waiting).not.toContain('Connect a model to start');
    expect(backend.openedUrls).toHaveLength(1);
    expect(backend.planCalls.filter((call) => call.route === 'sign-in/begin').map((call) => call.body)).toEqual([{ profile: 'chatgpt', account: 'chatgpt', port: LISTENER_PORT }]);
    app.unmount();
  });

  it('cancelling the waiting screen of Continue with ChatGPT returns to the welcome list', async () => {
    const { app, backend } = await startPlan({ models: [], accounts: [], callbackArrives: false });
    await choose(app, 'Continue with ChatGPT');
    await untilFrame(app, PASTE_LABEL);
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (shown) => shown.includes('Connect a model to start') && shown.includes('1. Continue with ChatGPT') && !shown.includes(PASTE_LABEL));
    expect(backend.planCalls.filter((call) => call.route === 'sign-in/begin')).toHaveLength(1);
    expect(backend.openedUrls).toHaveLength(1);
    app.unmount();
  });

  it('Use an API key starts the flow that asks for the API, the address, the key and the name, and prints no help text', async () => {
    const { app, backend } = await startPlan({ models: [], accounts: [] });
    await choose(app, 'Use an API key');
    await choose(app, 'OpenAI-compatible API');
    await untilFrame(app, 'Address:');
    await submitLine(app, 'https://api.example.com/v1');
    const keyChoice = await untilFrame(app, 'Save the key in the system secret store');
    expect(keyChoice).toContain('Read the key from an environment variable');
    await choose(app, 'Read the key from an environment variable');
    await untilFrame(app, 'Name of the environment variable');
    await submitLine(app, 'EXAMPLE_API_KEY');
    const named = await untilFrame(app, 'Name of the service');
    expect(named).not.toContain('takes an API key in one of two ways');
    expect(backend.planCalls.map((call) => call.route).filter((route) => route !== 'accounts')).toEqual([]);
    app.unmount();
  });
});

describe('the unconnected phase', () => {
  const unconnected = () => startPlan({ models: [], accounts: [account({ state: 'needs_sign_in', active: false, pinnedBy: [] })] });

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
    const { app } = await startPlan({ models: [], accounts: [account({ state: 'needs_sign_in', active: false, pinnedBy: [] })] }, {}, { columns: 100, rows: 200 });
    await untilFrame(app, UNCONNECTED_FOOTER);
    await submitLine(app, '/help');
    const frame = await untilFrame(app, 'Commands\n');
    expect(frame).toContain('/login');
    expect(frame).not.toContain(NEEDS_SESSION);
    app.unmount();
  });
});

describe('local servers from the welcome', () => {
  const ADDRESS = 'http://127.0.0.1:11434';
  const ollama: LocalServerDetection = { kind: 'ollama', provider: 'ollama', address: ADDRESS, models: [{ id: 'llama3.2:latest', tools: 'yes', ceiling: 131072 }] };
  const lmstudio: LocalServerDetection = {
    kind: 'lmstudio',
    provider: 'lmstudio',
    address: 'http://127.0.0.1:1234/v1',
    models: [
      { id: 'reported-model', tools: 'unknown', contextWindow: 32768 },
      { id: 'silent-model', tools: 'unknown' },
    ],
  };
  const writtenBy = (backend: { modelsFile(): string }): { models: { connections: Record<string, unknown>[] } } | undefined =>
    fs.existsSync(backend.modelsFile()) ? (JSON.parse(fs.readFileSync(backend.modelsFile(), 'utf8')) as { models: { connections: Record<string, unknown>[] } }) : undefined;

  it('searches on the user action, shows what it found, and writes nothing until a model is chosen and confirmed', async () => {
    const { app, backend } = await startPlan({ models: [], accounts: [], detected: [ollama] });
    expect(backend.detections).toEqual([]);
    await choose(app, 'Use a local server');
    const frame = await untilFrame(app, ADDRESS);
    expect(frame).toContain(`ollama  ·  ${ADDRESS}  ·  1 model`);
    expect(backend.detections.map((request) => request.typed)).toEqual([[]]);
    expect(writtenBy(backend)).toBeUndefined();
    app.unmount();
  });

  it('adds an Ollama model whose server reports its maximum without asking for a window, writes no window after the confirm row and opens the session', async () => {
    const { app, backend } = await startPlan({ models: [], accounts: [], detected: [ollama] }, { initialPrompt: 'hello there' });
    await choose(app, 'Use a local server');
    await choose(app, `ollama  ·  ${ADDRESS}`);
    await choose(app, 'llama3.2');
    await untilFrame(app, 'Add ollama/llama3.2 to your settings?');
    expect(writtenBy(backend)).toBeUndefined();
    await choose(app, 'Yes');
    await backend.called('openSession');
    expect(writtenBy(backend)?.models.connections).toMatchObject([{ adapter: 'ollama', baseUrl: ADDRESS }]);
    expect(writtenBy(backend)?.models.connections[0]?.['models']).toEqual([{ id: 'llama3.2:latest' }]);
    expect(backend.opened[0]?.model).toBe('ollama/llama3.2:latest');
    await eventually(() => backend.started.length > 0, 'the initial prompt');
    expect(backend.started.map((run) => run.text)).toEqual(['hello there']);
    app.unmount();
  });

  it('adds a model whose server reports a window without asking for one', async () => {
    const { app, backend } = await startPlan({ models: [], accounts: [], detected: [lmstudio] });
    await choose(app, 'Use a local server');
    await choose(app, 'lmstudio  ·  http://127.0.0.1:1234/v1');
    await choose(app, 'reported-model');
    await untilFrame(app, 'Add lmstudio/reported-model to your settings?');
    await choose(app, 'Yes');
    await backend.called('openSession');
    expect(writtenBy(backend)?.models.connections).toMatchObject([{ provider: 'lmstudio', models: [{ id: 'reported-model', capabilities: { contextWindow: 32768 } }] }]);
    app.unmount();
  });

  it('asks for the window of a model whose server reports none, with no ceiling and no prefilled value, and writes the entry', async () => {
    const { app, backend } = await startPlan({ models: [], accounts: [], detected: [lmstudio] });
    await choose(app, 'Use a local server');
    await choose(app, 'lmstudio  ·  http://127.0.0.1:1234/v1');
    await choose(app, 'silent-model');
    await untilFrame(app, 'Context window for lmstudio/silent-model:');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'Enter a whole number of at least 1.');
    expect(writtenBy(backend)).toBeUndefined();
    await submitLine(app, '16384');
    await untilFrame(app, 'Add lmstudio/silent-model to your settings?');
    await choose(app, 'Yes');
    await backend.called('openSession');
    expect(writtenBy(backend)?.models.connections).toMatchObject([{ provider: 'lmstudio', models: [{ id: 'silent-model', capabilities: { contextWindow: 16384 } }] }]);
    app.unmount();
  });

  it('says that no server answered, with what to do next, when the search finds none', async () => {
    const { app } = await startPlan({ models: [], accounts: [], detected: [] });
    await choose(app, 'Use a local server');
    await untilOutput(app, 'No model server answered on this computer. Start one, or add it with /model, then Model settings…, then Add a model.');
    app.unmount();
  });
});

describe('the invitation banner', () => {
  it('invites a home with a model and no account with one line that names /login, and Not now in /login is remembered as invite:chatgpt', async () => {
    const { app, backend } = await startPlan({ accounts: [] });
    const frame = await untilFrame(app, 'Use your ChatGPT plan in this app.');
    expect(frame).toContain('/login');
    expect(frame).not.toContain('Not now');
    await submitLine(app, '/login');
    await choose(app, 'Not now');
    await eventually(() => backend.dismissals.length > 0, 'the dismissal');
    expect(backend.dismissals).toEqual(['invite:chatgpt']);
    await untilFrame(app, (shown) => !shown.includes('Not now'));
    await untilPromptDrawn(app);
    expect(await untilTypedAfter(app)).not.toContain('Use your ChatGPT plan in this app.');
    app.unmount();
  });

  it('is not shown once dismissed', async () => {
    const { app, backend } = await startPlan({ accounts: [], dismissed: { 'invite:chatgpt': '2026-11-01T00:00:00.000Z' } });
    await backend.called('openSession');
    await sessionShown(app);
    expect(app.frames.join('\n')).not.toContain('Use your ChatGPT plan in this app.');
    app.unmount();
  });

  it('is not shown to a home that has an account, even a signed-out one', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ state: 'registered', active: false })] });
    await backend.called('openSession');
    await sessionShown(app);
    expect(app.frames.join('\n')).not.toContain('Use your ChatGPT plan in this app.');
    app.unmount();
  });
});
