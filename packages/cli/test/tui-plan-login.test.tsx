import { describe, expect, it, vi } from 'vitest';
import { runView } from './fake-backend.ts';
import { KEYS, untilFrame, untilOutput } from './ink-helpers.ts';
import type { Instance } from './ink-helpers.ts';
import { frame, runStarted } from './tui-harness.tsx';
import { AUTHORIZATION_URL, LISTENER_PORT, PLAN_TEST_TIMEOUT_MS, account, choose, eventually, quiet, rowNumberOf, startPlan, submitLine } from './fake-plan-gateway.tsx';
import type { FakePlanBackend } from './fake-plan-gateway.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const SENTENCE ='Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.';

const ready = async (app: Instance): Promise<void> => {
  await untilFrame(app, 'mode: default');
};

const routesOf = (backend: FakePlanBackend): string[] => backend.planCalls.map((call) => call.route);

const bodyOf = (backend: FakePlanBackend, route: string): unknown => backend.planCalls.find((call) => call.route === route)?.body;

describe('/login opens the generic list of every way to connect', () => {
  it('lists the subscription, API-key and local-server groups even with one shipped profile, and signs in to nothing yet', async () => {
    const { app, backend } = await startPlan({ accounts: [] });
    await ready(app);
    await submitLine(app, '/login');
    const listed = await untilFrame(app, 'Add a local server');
    expect(listed).toContain('OpenAI (ChatGPT subscription)');
    expect(listed).toContain('[subscription]');
    expect(listed).toContain('not signed in');
    expect(listed).toContain('Add an API key');
    expect(routesOf(backend)).not.toContain('sign-in/begin');
    app.unmount();
  });

  it('marks a signed-in subscription row with the account label', async () => {
    const { app } = await startPlan({ accounts: [account({ label: 'work' })] });
    await ready(app);
    await submitLine(app, '/login');
    const listed = await untilFrame(app, 'Add a local server');
    expect(listed).toContain('signed in as work');
    app.unmount();
  });

  it('/login chatgpt skips the list and opens the account picker', async () => {
    const { app } = await startPlan({ accounts: [account({ label: 'work' })] });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    const picker = await untilFrame(app, 'Add another account or workspace');
    expect(picker).toContain('work · ada@example.com · active');
    expect(picker).not.toContain('Add a local server');
    expect(picker).not.toContain('Add an API key');
    app.unmount();
  });
});

describe('where /login <provider> leads', () => {
  it('goes to the sentence screen with the first free label when the profile has no account record', async () => {
    const { app, backend } = await startPlan({ accounts: [] });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    const screen = await untilFrame(app, SENTENCE);
    expect(screen).not.toContain('Add another account or workspace');
    await choose(app, 'Continue with ChatGPT');
    await eventually(() => routesOf(backend).includes('sign-in/begin'), 'the sign-in start');
    expect(bodyOf(backend, 'sign-in/begin')).toEqual({ profile: 'chatgpt', account: 'chatgpt', port: LISTENER_PORT });
    app.unmount();
  });
});

describe('choosing a saved account in the picker', () => {
  it('an active account only moves the active pointer', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ label: 'home' }), account({ label: 'work', email: 'w@example.com', active: false })] });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    await choose(app, 'work · w@example.com');
    await eventually(() => routesOf(backend).includes('accounts/active'), 'the pointer move');
    await quiet();
    expect(bodyOf(backend, 'accounts/active')).toEqual({ profile: 'chatgpt', account: 'work' });
    expect(routesOf(backend).filter((route) => route !== 'accounts' && route !== 'accounts/active')).toEqual([]);
    expect(backend.listenerPaths).toEqual([]);
    app.unmount();
  });

  it('an account that needs sign-in shows the sentence screen', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ label: 'work', email: 'w@example.com', state: 'needs_sign_in' })] });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    await choose(app, 'work · w@example.com');
    await untilFrame(app, SENTENCE);
    expect(routesOf(backend)).not.toContain('sign-in/begin');
    app.unmount();
  });

  it('an account whose record is unreadable starts nothing', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ label: 'work', email: 'w@example.com', state: 'store_unreadable', cause: 'bad tag' })] });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    const picker = await untilFrame(app, 'work · w@example.com · record unreadable');
    expect(picker).not.toContain('sign-in required');
    await choose(app, 'work · w@example.com');
    await quiet();
    expect(routesOf(backend).filter((route) => route !== 'accounts')).toEqual([]);
    expect(backend.listenerPaths).toEqual([]);
    expect(app.lastFrame()).not.toContain(SENTENCE);
    app.unmount();
  });
});

describe('the account picker and a new sign-in', () => {
  it('offers the first free label, here chatgpt-2 between chatgpt and chatgpt-3, and runs the loopback sign-in with it', async () => {
    const { app, backend } = await startPlan({
      accounts: [account({ label: 'chatgpt' }), account({ label: 'chatgpt-3', state: 'registered', active: false, pinnedBy: [] })],
    });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    await choose(app, 'Add another account or workspace');
    await untilFrame(app, 'chatgpt-2');
    app.stdin.write(KEYS.enter);
    const sentence = await untilFrame(app, SENTENCE);
    expect(sentence).toContain('Continue with ChatGPT');
    await choose(app, 'Continue with ChatGPT');
    await eventually(() => routesOf(backend).includes('sign-in/complete'), 'the sign-in completion');
    expect(backend.listenerPaths).toEqual(['/auth/callback']);
    expect(bodyOf(backend, 'sign-in/begin')).toEqual({ profile: 'chatgpt', account: 'chatgpt-2', port: LISTENER_PORT });
    expect(backend.openedUrls).toEqual([AUTHORIZATION_URL]);
    expect(bodyOf(backend, 'sign-in/complete')).toEqual({ attemptId: 'attempt-1', callbackUrl: `http://127.0.0.1:${LISTENER_PORT}/auth/callback?code=code-1&state=st-1` });
    app.unmount();
  });

  it('shows the first-sign-in confirmation when complete answers firstSignIn, and Got it closes it', async () => {
    const { app } = await startPlan({ accounts: [], complete: { outcome: 'signed_in', account: account(), firstSignIn: true } });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    await choose(app, 'Continue with ChatGPT');
    const overlay = await untilFrame(app, "You're using your ChatGPT plan");
    expect(overlay).toContain('Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.');
    await choose(app, 'Got it');
    await eventually(() => !(app.lastFrame() ?? '').includes("You're using your ChatGPT plan"), 'the overlay closing');
    app.unmount();
  });

  it('does not show the confirmation when complete answers firstSignIn false', async () => {
    const { app, backend } = await startPlan({ accounts: [], complete: { outcome: 'signed_in', account: account(), firstSignIn: false } });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    await choose(app, 'Continue with ChatGPT');
    await eventually(() => routesOf(backend).includes('sign-in/complete'), 'the sign-in completion');
    await quiet();
    expect(app.frames.join('\n')).not.toContain("You're using your ChatGPT plan");
    app.unmount();
  });

  it('ends a sign-in that leaves no target in the model picker; choosing a row creates the target, opens the session and sends the prompt once', async () => {
    const { app, backend } = await startPlan(
      {
        aliases: [],
        accounts: [account({ state: 'needs_sign_in', active: false, pinnedBy: [] })],
        complete: { outcome: 'signed_in', account: account({ pinnedBy: [] }), firstSignIn: false },
        catalogs: { chatgpt: { readAt: '2026-11-10T00:00:00.000Z', models: [{ slug: 'gpt-5.1', displayName: 'GPT-5.1', usable: true, contextWindow: 272000, maxOutputTokens: 128000 }] } },
      },
      { initialPrompt: 'start here' },
    );
    await untilFrame(app, 'no model connected · /login');
    await submitLine(app, '/login chatgpt');
    await choose(app, 'chatgpt · ada@example.com');
    await choose(app, 'Continue with ChatGPT');
    await choose(app, 'gpt-5.1');
    await backend.called('openSession');
    expect(bodyOf(backend, 'accounts/chatgpt/targets')).toEqual({ profile: 'chatgpt', slug: 'gpt-5.1' });
    await eventually(() => backend.started.length > 0, 'the initial prompt');
    await quiet();
    expect(backend.started.map((run) => run.text)).toEqual(['start here']);
    app.unmount();
  });
});

describe('/logout', () => {
  it('lists the stored accounts and signs out the chosen one only on the second press, staying in the session', async () => {
    const { app, backend, outcomes } = await startPlan({ accounts: [account({ label: 'home' }), account({ label: 'work', active: false })] });
    await ready(app);
    await submitLine(app, '/logout');
    const listed = await untilFrame(app, 'work · ada@example.com');
    expect(listed).toContain('home · ada@example.com');
    await choose(app, 'work · ada@example.com');
    await quiet();
    expect(routesOf(backend)).not.toContain('sign-out');
    app.stdin.write(KEYS.enter);
    await eventually(() => routesOf(backend).includes('sign-out'), 'the sign-out');
    expect(bodyOf(backend, 'sign-out')).toEqual({ profile: 'chatgpt', account: 'work' });
    expect(backend.planCalls.filter((call) => call.route === 'sign-out')).toHaveLength(1);
    expect(outcomes).toEqual([]);
    app.unmount();
  });
});

describe('Using ChatGPT plan in the footer', () => {
  const planned = {
    targets: ['plan-gpt', 'metered-key'],
    billing: { 'plan-gpt': 'plan', 'metered-key': 'metered' } as const,
    planTargets: { 'plan-gpt': { profile: 'chatgpt', account: 'chatgpt' } },
    accounts: [account()],
  };

  it('shows nothing before the first call, then the label and the Manage usage link when a plan target served the call', async () => {
    const { app, backend } = await startPlan(planned);
    await ready(app);
    expect(app.lastFrame()).not.toContain('Using ChatGPT plan');
    await runStarted(backend, app, 'go');
    backend.emit(frame({ type: 'model.responded', attempt: 0, target: 'plan-gpt', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
    const footer = await untilFrame(app, 'Using ChatGPT plan');
    expect(footer).toContain('Manage usage');
    expect(footer).toContain('https://chatgpt.com/settings/usage');
    app.unmount();
  });

  it('follows the call, not the alias: the label goes away when the next call is served by a metered target', async () => {
    const { app, backend } = await startPlan(planned);
    await ready(app);
    await runStarted(backend, app, 'go');
    backend.emit(frame({ type: 'model.responded', attempt: 0, target: 'plan-gpt', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
    await untilFrame(app, 'Using ChatGPT plan');
    backend.emit(frame({ type: 'model.responded', attempt: 0, target: 'metered-key', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
    backend.emit(frame({ type: 'usage.updated', inputTokens: 2, outputTokens: 2, totalTokens: 4 }));
    await untilFrame(app, 'tokens: 4');
    await quiet();
    expect(app.lastFrame()).not.toContain('Using ChatGPT plan');
    app.unmount();
  });
});

describe('the model picker', () => {
  it('turns a plan target that needs sign-in into the sign-in flow for its profile', async () => {
    const { app } = await startPlan({
      targets: ['plan-gpt'],
      billing: { 'plan-gpt': 'plan' },
      planTargets: { 'plan-gpt': { profile: 'chatgpt', account: 'chatgpt' } },
      health: { 'plan-gpt': { ok: false, breaker: 'closed', reason: 'sign_in_required' } },
      accounts: [account({ state: 'needs_sign_in' })],
    });
    await ready(app);
    await submitLine(app, '/model');
    await choose(app, 'default');
    await untilFrame(app, SENTENCE);
    app.unmount();
  });

  it('lists a catalog model that is not yet a target, tagged with the profile picker label, and choosing it creates the target', async () => {
    const { app, backend } = await startPlan({
      accounts: [account()],
      catalogs: {
        chatgpt: {
          readAt: '2026-11-10T00:00:00.000Z',
          models: [
            { slug: 'gpt-5.1', displayName: 'GPT-5.1', usable: true, contextWindow: 272000, maxOutputTokens: 128000 },
            { slug: 'gpt-odd', displayName: 'Odd', usable: false, reason: 'no context window reported' },
          ],
        },
      },
    });
    await ready(app);
    await submitLine(app, '/model');
    const picker = await untilFrame(app, 'gpt-5.1');
    const row = picker.split('\n').find((line) => line.includes('gpt-5.1')) ?? '';
    expect(row).toContain('OpenAI (ChatGPT subscription)');
    expect(picker).toContain('no context window reported');
    await choose(app, 'gpt-5.1');
    await eventually(() => routesOf(backend).includes('accounts/chatgpt/targets'), 'the target creation');
    expect(bodyOf(backend, 'accounts/chatgpt/targets')).toEqual({ profile: 'chatgpt', slug: 'gpt-5.1' });
    await backend.called('model:gpt-5.1');
    app.unmount();
  });
});

describe('plan errors in the transcript', () => {
  it('names /login for an expired sign-in, with the cause code on a second line', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ state: 'needs_sign_in' })] });
    await ready(app);
    await runStarted(backend, app, 'go');
    backend.finish(runView({ status: 'FAILED', error: { code: 'sign_in_required', message: 'ChatGPT sign-in expired' } }));
    const output = await untilOutput(app, 'ChatGPT sign-in expired · Run /login to sign in again');
    const lines = (app.lastFrame() ?? output).split('\n');
    const at = lines.findIndex((line) => line.includes('ChatGPT sign-in expired · Run /login to sign in again'));
    expect(lines[at + 1]).toContain('sign_in_required');
    app.unmount();
  });

  it('keeps the ChatGPT identity on a usage limit and makes Manage usage the primary action', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ paused: {} })] });
    await ready(app);
    await runStarted(backend, app, 'go');
    backend.finish(runView({ status: 'STOPPED', stopReason: 'usage_limit' as never, error: { code: 'plan_usage_limit', message: 'Manage usage', plan: { profile: 'chatgpt', account: 'chatgpt' } } as never }));
    const block = await untilFrame(app, "Review your plan or this app's limit in ChatGPT settings.");
    const limit = block.indexOf('Usage limit reached');
    expect(limit).toBeGreaterThan(-1);
    expect(block.lastIndexOf('ChatGPT', limit)).toBeGreaterThan(-1);
    expect(rowNumberOf(block, 'Manage usage')).toBe(1);
    expect(rowNumberOf(block, 'Dismiss')).toBe(2);
    await choose(app, 'Manage usage');
    await eventually(() => backend.openedUrls.length > 0, 'the usage page opening');
    expect(backend.openedUrls).toEqual(['https://chatgpt.com/settings/usage']);
    app.unmount();
  });
});
