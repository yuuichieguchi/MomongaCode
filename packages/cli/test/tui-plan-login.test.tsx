import { describe, expect, it, vi } from 'vitest';
import { PLAN_LABEL_REFUSAL } from '@momonga/protocol';
import type { PlanModelsResponse } from '@momonga/protocol';
import { runView } from './fake-backend.ts';
import { KEYS, untilFrame, untilOutput, withoutLinks } from './ink-helpers.ts';
import type { Instance } from './ink-helpers.ts';
import { frame, runStarted } from './tui-harness.tsx';
import { authLogout } from '../src/commands/auth.ts';
import { account, AUTHORIZATION_URL, CHATGPT, choose, eventually, fakePlanBackend, LISTENER_PORT, PLAN_TEST_TIMEOUT_MS, rowNumberOf, startPlan, submitLine, untilRow, untilTypedAfter } from './fake-plan-gateway.tsx';
import type { FakePlanBackend } from './fake-plan-gateway.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const SENTENCE ='Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.';

const PASTE_LABEL = 'On a remote machine? Paste the redirect URL here';

const flat = (shown: string): string => shown.replace(/\s+/g, ' ');

const ready = async (app: Instance): Promise<void> => {
  await untilFrame(app, 'mode: manual');
};

const routesOf = (backend: FakePlanBackend): string[] => backend.planCalls.map((call) => call.route);

const bodyOf = (backend: FakePlanBackend, route: string): unknown => backend.planCalls.find((call) => call.route === route)?.body;

describe('/login opens the generic list of every way to connect', () => {
  it('lists the subscription and API-key groups even with one shipped profile, no local server, and signs in to nothing yet', async () => {
    const { app, backend } = await startPlan({ accounts: [] });
    await ready(app);
    await submitLine(app, '/login');
    const listed = await untilFrame(app, 'Add an API key');
    expect(listed).toContain('OpenAI (ChatGPT subscription)');
    expect(listed).toContain('[subscription]');
    expect(listed).toContain('not signed in');
    expect(listed).toContain('Add an API key');
    expect(listed).not.toContain('local server');
    expect(routesOf(backend)).not.toContain('sign-in/begin');
    app.unmount();
  });

  it('the subscription row shows the description, and choosing it opens the browser once with no second list; the waiting screen shows the description and the URL', async () => {
    const { app, backend } = await startPlan({ accounts: [], callbackArrives: false });
    await ready(app);
    await submitLine(app, '/login');
    const listed = await untilFrame(app, 'Add an API key');
    expect(flat(listed)).toContain(SENTENCE);
    await choose(app, 'OpenAI (ChatGPT subscription)');
    const waiting = await untilFrame(app, PASTE_LABEL);
    expect(flat(waiting)).toContain(SENTENCE);
    expect(waiting.replace(/\s+/g, '')).toContain(AUTHORIZATION_URL);
    expect(waiting).not.toContain(CHATGPT.messages.apiKeyLabel);
    await eventually(() => backend.openedUrls.length === 1, 'the browser stand-in was asked once');
    expect(routesOf(backend).filter((route) => route === 'sign-in/begin')).toHaveLength(1);
    expect(bodyOf(backend, 'sign-in/begin')).toEqual({ profile: 'chatgpt', account: 'chatgpt', port: LISTENER_PORT });
    app.unmount();
  });

  it('cancelling the waiting screen returns to the /login list with nothing changed', async () => {
    const { app, backend } = await startPlan({ accounts: [], callbackArrives: false });
    await ready(app);
    await submitLine(app, '/login');
    await choose(app, 'OpenAI (ChatGPT subscription)');
    await untilFrame(app, PASTE_LABEL);
    app.stdin.write(KEYS.escape);
    const listed = await untilFrame(app, (shown) => shown.includes('Add an API key') && !shown.includes(PASTE_LABEL));
    expect(listed).toContain('not signed in');
    expect(routesOf(backend).filter((route) => route === 'sign-in/begin')).toHaveLength(1);
    expect(routesOf(backend)).not.toContain('sign-in/complete');
    expect(backend.openedUrls).toHaveLength(1);
    app.unmount();
  });

  it('a subscription row of a profile with a saved account shows no description and leads to the account picker', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ label: 'work' })] });
    await ready(app);
    await submitLine(app, '/login');
    const listed = await untilFrame(app, 'Add an API key');
    expect(flat(listed)).not.toContain(SENTENCE);
    await choose(app, 'OpenAI (ChatGPT subscription)');
    await untilFrame(app, 'Add another account or workspace');
    expect(routesOf(backend)).not.toContain('sign-in/begin');
    app.unmount();
  });

  it('marks a signed-in subscription row with the account label', async () => {
    const { app } = await startPlan({ accounts: [account({ label: 'work' })] });
    await ready(app);
    await submitLine(app, '/login');
    const listed = await untilFrame(app, 'Add an API key');
    expect(listed).toContain('signed in as work');
    app.unmount();
  });

  it('/login chatgpt skips the list and opens the account picker', async () => {
    const { app } = await startPlan({ accounts: [account({ label: 'work' })] });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    const picker = await untilFrame(app, 'Add another account or workspace');
    expect(picker).toContain('work · ada@example.com · active');
    expect(picker).not.toContain('Add an API key');
    expect(picker).not.toContain('Add an API key');
    app.unmount();
  });
});

describe('where /login <provider> leads', () => {
  it('starts the sign-in at once with the first free label when the profile has no account record: the waiting screen shows the description and the URL, and no second list', async () => {
    const { app, backend } = await startPlan({ accounts: [], callbackArrives: false });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    const screen = await untilFrame(app, PASTE_LABEL);
    expect(flat(screen)).toContain(SENTENCE);
    expect(screen.replace(/\s+/g, '')).toContain(AUTHORIZATION_URL);
    expect(screen).not.toContain('Add another account or workspace');
    expect(screen).not.toContain(CHATGPT.messages.apiKeyLabel);
    expect(backend.openedUrls).toEqual([AUTHORIZATION_URL]);
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
    await untilTypedAfter(app);
    expect(bodyOf(backend, 'accounts/active')).toEqual({ profile: 'chatgpt', account: 'work' });
    expect(routesOf(backend).filter((route) => route !== 'accounts' && route !== 'accounts/active')).toEqual([]);
    expect(backend.listenerPaths).toEqual([]);
    app.unmount();
  });

  it('an account that needs sign-in shows the description under its row and starts its sign-in at once when chosen', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ label: 'work', email: 'w@example.com', state: 'needs_sign_in' })], callbackArrives: false });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    const picker = await untilRow(app, 'work · w@example.com');
    expect(flat(picker)).toContain(SENTENCE);
    expect(routesOf(backend)).not.toContain('sign-in/begin');
    await choose(app, 'work · w@example.com');
    await untilFrame(app, PASTE_LABEL);
    expect(bodyOf(backend, 'sign-in/begin')).toMatchObject({ profile: 'chatgpt', account: 'work' });
    expect(backend.openedUrls).toEqual([AUTHORIZATION_URL]);
    app.unmount();
  });

  it('an account whose record is unreadable shows its cause and what replaces or forgets it, and its sign-in starts once, only when the person chooses it', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ label: 'work', email: 'w@example.com', state: 'store_unreadable', cause: 'bad tag' })] });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    const picker = await untilFrame(app, 'work · w@example.com · record unreadable');
    expect(picker).not.toContain('sign-in required');
    expect(routesOf(backend)).not.toContain('sign-in/begin');
    await choose(app, 'work · w@example.com');
    const shown = flat(await untilOutput(app, 'The saved record of work'));
    expect(shown).toContain('The saved record of work cannot be read (bad tag). Run /login to replace it with a new sign-in, or /logout to forget it on this computer; forgetting it does not revoke the session at the provider.');
    await eventually(() => routesOf(backend).includes('sign-in/begin'), 'the sign-in start');
    expect(routesOf(backend).filter((route) => route !== 'accounts')[0]).toBe('sign-in/begin');
    expect(routesOf(backend).filter((route) => route === 'sign-in/begin')).toHaveLength(1);
    expect(backend.listenerPaths).toHaveLength(1);
    expect(bodyOf(backend, 'sign-in/begin')).toMatchObject({ profile: 'chatgpt', account: 'work' });
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
    await eventually(() => routesOf(backend).includes('sign-in/complete'), 'the sign-in completion');
    expect(backend.listenerPaths).toEqual(['/auth/callback']);
    expect(bodyOf(backend, 'sign-in/begin')).toEqual({ profile: 'chatgpt', account: 'chatgpt-2', port: LISTENER_PORT });
    expect(backend.openedUrls).toEqual([AUTHORIZATION_URL]);
    expect(bodyOf(backend, 'sign-in/complete')).toEqual({ attemptId: 'attempt-1', callbackUrl: `http://127.0.0.1:${LISTENER_PORT}/auth/callback?code=code-1&state=st-1` });
    app.unmount();
  });

  it('refuses a label outside the label rule with the one text of every surface and begins no sign-in', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ label: 'chatgpt' })] });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    await choose(app, 'Add another account or workspace');
    await untilFrame(app, 'chatgpt-2');
    app.stdin.write('/x');
    await untilFrame(app, 'chatgpt-2/x');
    app.stdin.write(KEYS.enter);
    const refused = withoutLinks(await untilFrame(app, 'the account label must match'));
    expect(refused).not.toContain('a label must match');
    expect(refused.replaceAll(/\s+/g, '')).toContain(PLAN_LABEL_REFUSAL.replaceAll(/\s+/g, ''));
    expect(routesOf(backend)).not.toContain('sign-in/begin');
    app.unmount();
  });

  it('shows the first-sign-in confirmation when complete answers firstSignIn, and Got it closes it', async () => {
    const { app } = await startPlan({ accounts: [], complete: { outcome: 'signed_in', account: account(), firstSignIn: true } });
    await ready(app);
    await submitLine(app, '/login chatgpt');
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
    await eventually(() => routesOf(backend).includes('sign-in/complete'), 'the sign-in completion');
    await untilTypedAfter(app);
    expect(app.frames.join('\n')).not.toContain("You're using your ChatGPT plan");
    app.unmount();
  });

  it('ends a sign-in that leaves no target in the model picker; choosing a row creates the target, opens the session and sends the prompt once', async () => {
    const { app, backend } = await startPlan(
      {
        models: [],
        accounts: [account({ state: 'needs_sign_in', active: false, pinnedBy: [] })],
        complete: { outcome: 'signed_in', account: account({ pinnedBy: [] }), firstSignIn: false },
        catalogs: { chatgpt: { readAt: '2026-11-10T00:00:00.000Z', models: [{ slug: 'gpt-5.1', displayName: 'GPT-5.1', usable: true, contextWindow: 272000, maxOutputTokens: 128000 }] } },
      },
      { initialPrompt: 'start here' },
    );
    await untilFrame(app, 'no model connected · /login');
    await submitLine(app, '/login chatgpt');
    await choose(app, 'chatgpt · ada@example.com');
    await choose(app, 'gpt-5.1');
    await backend.called('openSession');
    expect(bodyOf(backend, 'accounts/chatgpt/targets')).toEqual({ profile: 'chatgpt', slug: 'gpt-5.1' });
    await eventually(() => backend.started.length > 0, 'the initial prompt');
    await untilTypedAfter(app);
    expect(backend.started.map((run) => run.text)).toEqual(['start here']);
    app.unmount();
  });
});

describe('an account that becomes the one in use', () => {
  const GPT = { readAt: '2026-11-10T00:00:00.000Z', models: [{ slug: 'gpt-5.1', displayName: 'GPT-5.1', usable: true, contextWindow: 272000, maxOutputTokens: 128000 }] } satisfies PlanModelsResponse;

  const STARTUP = { version: '1.2.3', home: '/Users/ada' };

  const figureModel = (shown: string): string => /model: (\S+)/.exec(shown.split('\n').filter((line) => line.includes('model: ')).at(-1) ?? '')?.[1] ?? '';

  it('an active account that serves no configured model, chosen from /login, opens its model list, and Enter on a model moves the session, and the start figure to it', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ pinnedBy: [] })], catalogs: { chatgpt: GPT } }, { startup: STARTUP });
    await ready(app);
    await submitLine(app, '/login');
    await choose(app, 'OpenAI (ChatGPT subscription)');
    await choose(app, 'chatgpt · ada@example.com');
    await untilOutput(app, 'ChatGPT account in use: chatgpt');
    await untilFrame(app, 'Choose a model of chatgpt');
    await choose(app, 'gpt-5.1');
    await untilOutput(app, 'model: chatgpt/gpt-5.1');
    expect(bodyOf(backend, 'accounts/chatgpt/targets')).toEqual({ profile: 'chatgpt', slug: 'gpt-5.1' });
    const after = await untilFrame(app, (shown) => figureModel(shown) === 'chatgpt/gpt-5.1');
    expect(after).not.toContain('still runs on');
    expect(app.frames.join('\n')).not.toContain('ChatGPT: using');
    app.unmount();
  });

  it('leaving the model list without a choice says the account is selected and the session still runs on its model', async () => {
    const { app } = await startPlan({ accounts: [account({ pinnedBy: [] })], catalogs: { chatgpt: GPT } }, { startup: STARTUP });
    await ready(app);
    const before = figureModel(app.lastFrame() ?? '');
    expect(before).not.toBe('');
    await submitLine(app, '/login chatgpt');
    await choose(app, 'chatgpt · ada@example.com');
    await untilFrame(app, 'Choose a model of chatgpt');
    app.stdin.write(KEYS.escape);
    const shown = flat(await untilOutput(app, 'still runs on'));
    expect(shown).toContain(`chatgpt is signed in and selected, but this session still runs on ${before}; /model lists the models of chatgpt and switches to one.`);
    expect(figureModel(app.lastFrame() ?? '')).toBe(before);
    app.unmount();
  });

  it('an active account that already serves a configured model other than the session model names the account, says the session model is unchanged and opens no list', async () => {
    const { app, backend } = await startPlan({ accounts: [account()], catalogs: { chatgpt: GPT } }, { startup: STARTUP });
    await ready(app);
    const before = figureModel(app.lastFrame() ?? '');
    await submitLine(app, '/login chatgpt');
    await choose(app, 'chatgpt · ada@example.com');
    const shown = flat(await untilOutput(app, 'still runs on'));
    expect(shown).toContain('ChatGPT account in use: chatgpt');
    expect(shown).toContain(`chatgpt is signed in and selected, but this session still runs on ${before}; /model lists the models of chatgpt and switches to one.`);
    await untilTypedAfter(app);
    expect(app.frames.join('\n')).not.toContain('Choose a model of chatgpt');
    expect(routesOf(backend)).not.toContain('accounts/chatgpt/models');
    expect(figureModel(app.lastFrame() ?? '')).toBe(before);
    app.unmount();
  });

  it('switching to another account that serves no configured model opens that account\'s model list', async () => {
    const { app } = await startPlan({ accounts: [account({ label: 'home' }), account({ label: 'work', email: 'w@example.com', active: false, pinnedBy: [] })], catalogs: { work: GPT } });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    await choose(app, 'work · w@example.com');
    await untilOutput(app, 'ChatGPT account in use: work');
    const picker = await untilFrame(app, 'Choose a model of work');
    expect(picker).toContain('gpt-5.1');
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
    await untilFrame(app, 'again to sign out');
    expect(routesOf(backend)).not.toContain('sign-out');
    app.stdin.write(KEYS.enter);
    await eventually(() => routesOf(backend).includes('sign-out'), 'the sign-out');
    expect(bodyOf(backend, 'sign-out')).toEqual({ profile: 'chatgpt', account: 'work' });
    expect(backend.planCalls.filter((call) => call.route === 'sign-out')).toHaveLength(1);
    expect(outcomes).toEqual([]);
    app.unmount();
  });
});

describe('a command and the TUI print the same sign-out lines (P-C8)', () => {
  it.each([
    ['confirmed', ['Signed out work', 'Remote revocation confirmed.']],
    ['unconfirmed', ['Signed out work', 'Remote revocation was not confirmed; disconnect the app in ChatGPT Settings: https://chatgpt.com/settings/usage']],
  ] as const)('a command and the TUI print the same sign-out lines (%s)', async (revocation, lines) => {
    const written: string[] = [];
    const commandBackend = fakePlanBackend({ accounts: [account({ label: 'work' })], signOutRevocation: revocation });
    const code = await authLogout({ stdout: { write: (text: string) => void written.push(text) }, stderr: { write: () => undefined }, plan: commandBackend.plan, isTerminal: false }, { account: 'work' });
    expect(code).toBe(0);
    expect(written.join('')).toBe(`${lines.join('\n')}\n`);

    const { app, backend } = await startPlan({ accounts: [account({ label: 'home' }), account({ label: 'work', active: false })], signOutRevocation: revocation });
    await ready(app);
    await submitLine(app, '/logout');
    await choose(app, 'work · ada@example.com');
    await untilFrame(app, 'again to sign out');
    app.stdin.write(KEYS.enter);
    await eventually(() => routesOf(backend).includes('sign-out'), 'the sign-out');
    const output = withoutLinks(await untilOutput(app, (shown) => withoutLinks(shown).includes(lines[1])));
    expect(output).toContain(lines[0]);
    app.unmount();
  });
});

describe('/logout of an account with nothing to sign out', () => {
  it('shows only that the account was already signed out', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ label: 'home' }), account({ label: 'work', active: false })], signOutRevocation: 'none' });
    await ready(app);
    await submitLine(app, '/logout');
    await choose(app, 'work · ada@example.com');
    await untilFrame(app, 'again to sign out');
    app.stdin.write(KEYS.enter);
    await eventually(() => routesOf(backend).includes('sign-out'), 'the sign-out');
    const output = await untilOutput(app, 'work was already signed out.');
    expect(output).not.toContain('Signed out work');
    expect(output).not.toContain('Remote revocation');
    app.unmount();
  });
});

describe('Using ChatGPT plan in the footer', () => {
  const planned = {
    chain: ['plan-gpt', 'metered-key'],
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

  it('follows the call, not the session model: the label goes away when the next call is served by a metered target', async () => {
    const { app, backend } = await startPlan(planned);
    await ready(app);
    await runStarted(backend, app, 'go');
    backend.emit(frame({ type: 'model.responded', attempt: 0, target: 'plan-gpt', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
    await untilFrame(app, 'Using ChatGPT plan');
    backend.emit(frame({ type: 'model.responded', attempt: 0, target: 'metered-key', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
    backend.emit(frame({ type: 'usage.updated', inputTokens: 2, outputTokens: 2, totalTokens: 4 }));
    expect(await untilFrame(app, 'tokens: 4')).not.toContain('Using ChatGPT plan');
    app.unmount();
  });
});

describe('the model picker', () => {
  it('turns a plan target that needs sign-in into the sign-in of its account at once, with no second list', async () => {
    const { app, backend } = await startPlan({
      chain: ['plan-gpt'],
      billing: { 'plan-gpt': 'plan' },
      planTargets: { 'plan-gpt': { profile: 'chatgpt', account: 'chatgpt' } },
      health: { 'plan-gpt': { ok: false, breaker: 'closed', reason: 'sign_in_required' } },
      accounts: [account({ state: 'needs_sign_in' })],
      callbackArrives: false,
    });
    await ready(app);
    await submitLine(app, '/model');
    await choose(app, 'plan-gpt');
    expect(flat(await untilFrame(app, PASTE_LABEL))).toContain(SENTENCE);
    expect(bodyOf(backend, 'sign-in/begin')).toMatchObject({ profile: 'chatgpt', account: 'chatgpt' });
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
    await backend.called('model:chatgpt/gpt-5.1');
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
    const block = await untilRow(app, 'Manage usage', "Review your plan or this app's limit in ChatGPT settings.");
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
