import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemTiming } from '@momonga/foundation';
import { authLogin, authLogout, authStatus, nextAccountLabel } from '../src/commands/auth.ts';
import { describeRunError } from '../src/policy-messages.ts';
import { SHELL_SLASH_COMMANDS } from '../src/tui/commands/shell-commands.ts';
import { dismissNotice, readDismissedNotices } from '../src/tui/dismissed-notices.ts';
import { AUTHORIZATION_URL, LISTENER_PORT, account, fakePlanBackend } from './fake-plan-gateway.tsx';
import { freshHome } from './fresh-home.ts';

const writer = () => {
  const written: string[] = [];
  return { written, write: (text: string): void => void written.push(text) };
};

describe('nextAccountLabel, the first free name in <profile>, <profile>-2, <profile>-3', () => {
  it('is the profile id when no record of the profile exists', () => {
    expect(nextAccountLabel('chatgpt', [])).toBe('chatgpt');
  });

  it('is the first free name, not one past the highest', () => {
    expect(nextAccountLabel('chatgpt', [account({ label: 'chatgpt' }), account({ label: 'chatgpt-3' })])).toBe('chatgpt-2');
  });

  it('counts a record in any state as taken', () => {
    const records = [account({ label: 'chatgpt', state: 'store_unreadable' }), account({ label: 'chatgpt-2', state: 'registered', active: false })];
    expect(nextAccountLabel('chatgpt', records)).toBe('chatgpt-3');
  });

  it('ignores records of another profile', () => {
    expect(nextAccountLabel('chatgpt', [account({ profile: 'other', label: 'chatgpt' })])).toBe('chatgpt');
  });
});

describe('state/dismissed-notices.json', () => {
  it('records a dismissal as { key: ISO time } with mode 0600 and reads it back', async () => {
    const state = path.join(freshHome(), 'state');
    fs.mkdirSync(state, { recursive: true });
    await dismissNotice(state, 'invite:chatgpt', new Date('2026-11-10T01:02:03.000Z'));
    const file = path.join(state, 'dismissed-notices.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ 'invite:chatgpt': '2026-11-10T01:02:03.000Z' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(await readDismissedNotices(state, () => undefined)).toEqual({ 'invite:chatgpt': '2026-11-10T01:02:03.000Z' });
  });

  it('keeps earlier dismissals when another is added', async () => {
    const state = path.join(freshHome(), 'state');
    fs.mkdirSync(state, { recursive: true });
    await dismissNotice(state, 'invite:chatgpt', new Date('2026-11-10T00:00:00.000Z'));
    await dismissNotice(state, 'invite:other', new Date('2026-11-11T00:00:00.000Z'));
    expect(await readDismissedNotices(state, () => undefined)).toEqual({ 'invite:chatgpt': '2026-11-10T00:00:00.000Z', 'invite:other': '2026-11-11T00:00:00.000Z' });
  });

  it('ignores a file that cannot be parsed, with a warning', async () => {
    const state = path.join(freshHome(), 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'dismissed-notices.json'), '{not json');
    const warnings: string[] = [];
    expect(await readDismissedNotices(state, (warning) => void warnings.push(warning))).toEqual({});
    expect(warnings).toHaveLength(1);
  });

  it('reads an absent file as no dismissals and no warning', async () => {
    const state = path.join(freshHome(), 'state');
    const warnings: string[] = [];
    expect(await readDismissedNotices(state, (warning) => void warnings.push(warning))).toEqual({});
    expect(warnings).toEqual([]);
  });
});

describe('describeRunError names the command of the surface for plan errors', () => {
  const expired = { code: 'sign_in_required', message: 'ChatGPT sign-in expired' };

  it('names /login in the TUI and keeps the cause code on a second line', () => {
    const lines = describeRunError(expired, 'tui');
    expect(lines[0]).toBe('ChatGPT sign-in expired · Run /login to sign in again');
    expect(lines[1]).toContain('sign_in_required');
  });

  it('names momonga auth login with the profile and label from the error plan data in a headless run', () => {
    const lines = describeRunError({ ...expired, plan: { profile: 'chatgpt', account: 'chatgpt' } }, 'headless');
    expect(lines[0]).toBe('ChatGPT sign-in expired · Run momonga auth login chatgpt --account chatgpt to sign in again');
    expect(lines[1]).toContain('sign_in_required');
  });

  it('names plain momonga auth login when the error carries no plan data', () => {
    const lines = describeRunError(expired, 'headless');
    expect(lines[0]).toBe('ChatGPT sign-in expired · Run momonga auth login to sign in again');
    expect(lines[1]).toContain('sign_in_required');
  });

  it('leaves other codes as they were', () => {
    expect(describeRunError({ code: 'provider_unavailable', message: 'down' }, 'tui')).toEqual(['provider_unavailable: down']);
  });
});

describe('/auth status and /status', () => {
  it('runs auth in-process like its neighbours, and /status keeps its run-tree meaning', () => {
    const auth = SHELL_SLASH_COMMANDS.find((command) => command.name === 'auth');
    expect(auth).toBeDefined();
    expect(auth?.usage).toContain('status');
    const status = SHELL_SLASH_COMMANDS.find((command) => command.name === 'status');
    expect(status?.usage).toBe('[run-id] [--json]');
  });
});

describe('momonga auth status', () => {
  it('prints each account with label, email, state words, the active marker and the usage URL', async () => {
    const out = writer();
    const backend = fakePlanBackend({
      accounts: [
        account({ label: 'home', email: 'home@example.com', state: 'active', active: true }),
        account({ label: 'paused', email: 'p@example.com', state: 'active', active: false, paused: {} }),
        account({ label: 'expired', email: 'e@example.com', state: 'needs_sign_in', active: false }),
        account({ label: 'off', email: 'o@example.com', state: 'plan_disabled', active: false }),
        account({ label: 'gone', email: 'g@example.com', state: 'registered', active: false }),
        account({ label: 'broken', email: 'b@example.com', state: 'store_unreadable', active: false, cause: 'bad tag' }),
        account({ label: 'stuck', email: 's@example.com', state: 'store_unwritable', active: false, cause: 'EACCES' }),
        account({ label: 'leaving', email: 'l@example.com', state: 'signing_out', active: false }),
      ],
    });
    const code = await authStatus({ stdout: out, plan: backend.plan, models: async () => [] }, { json: false });
    expect(code).toBe(0);
    const lines = out.written.join('').split('\n');
    const lineOf = (email: string): string => lines.find((line) => line.includes(email)) ?? '';
    expect(lineOf('home@example.com')).toContain('home');
    expect(lineOf('home@example.com')).toMatch(/^\s*\*/);
    expect(lineOf('home@example.com')).toContain('active');
    expect(lineOf('p@example.com')).toContain('paused by limit');
    expect(lineOf('p@example.com')).not.toMatch(/^\s*\*/);
    expect(lineOf('e@example.com')).toContain('sign-in required');
    expect(lineOf('o@example.com')).toContain('plan use not enabled');
    expect(lineOf('g@example.com')).toContain('signed out');
    expect(lineOf('b@example.com')).toContain('record unreadable');
    expect(lineOf('b@example.com')).not.toContain('sign-in required');
    expect(lineOf('s@example.com')).toContain('record not writable');
    expect(lineOf('l@example.com')).toContain('signing out');
    const brokenAt = lines.findIndex((line) => line.includes('b@example.com'));
    expect(lines[brokenAt + 1]).toContain('bad tag');
    expect(out.written.join('').split('https://chatgpt.com/settings/usage')).toHaveLength(2);
    expect(out.written.join('')).toContain('https://chatgpt.com/settings/usage');
    expect(lines.filter((line) => line.startsWith('model: '))).toEqual(['model: none']);
  });
});

describe('momonga auth login', () => {
  const loginPorts = (backend: ReturnType<typeof fakePlanBackend>, out: ReturnType<typeof writer>, err: ReturnType<typeof writer>) => {
    const opened: string[] = [];
    return {
      opened,
      ports: {
        stdout: out,
        stderr: err,
        plan: backend.plan,
        startListener: backend.startSignInListener,
        openUrl: async (url: URL) => void opened.push(url.href),
        sandbox: async () => 'seatbelt' as const,
        signal: new AbortController().signal,
        timers: systemTiming,
        isTerminal: false as const,
      },
    };
  };

  it('signs in with the first free label by default and passes the full callback URL to complete', async () => {
    const out = writer();
    const err = writer();
    const backend = fakePlanBackend({ accounts: [] });
    const { ports, opened } = loginPorts(backend, out, err);
    expect(await authLogin(ports, { provider: 'chatgpt' })).toBe(0);
    expect(backend.listenerPaths).toEqual(['/auth/callback']);
    expect(backend.planCalls.find((call) => call.route === 'sign-in/begin')?.body).toEqual({ profile: 'chatgpt', account: 'chatgpt', port: LISTENER_PORT });
    expect(opened).toEqual([AUTHORIZATION_URL]);
    expect(backend.planCalls.find((call) => call.route === 'sign-in/complete')?.body).toEqual({ attemptId: 'attempt-1', callbackUrl: `http://127.0.0.1:${LISTENER_PORT}/auth/callback?code=code-1&state=st-1` });
  });

  it('uses --account as the label', async () => {
    const out = writer();
    const err = writer();
    const backend = fakePlanBackend({ accounts: [] });
    const { ports } = loginPorts(backend, out, err);
    expect(await authLogin(ports, { provider: 'chatgpt', account: 'work' })).toBe(0);
    expect(backend.planCalls.find((call) => call.route === 'sign-in/begin')?.body).toEqual({ profile: 'chatgpt', account: 'work', port: LISTENER_PORT });
  });

  it('prints the first-sign-in text and the usage URL once when complete answers firstSignIn', async () => {
    const out = writer();
    const err = writer();
    const backend = fakePlanBackend({ accounts: [], complete: { outcome: 'signed_in', account: account(), firstSignIn: true } });
    const { ports } = loginPorts(backend, out, err);
    expect(await authLogin(ports, { provider: 'chatgpt' })).toBe(0);
    const printed = out.written.join('');
    expect(printed.split("You're using your ChatGPT plan")).toHaveLength(2);
    expect(printed).toContain('Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.');
    expect(printed.split('https://chatgpt.com/settings/usage')).toHaveLength(2);
  });
});

describe('momonga auth logout', () => {
  it('requires the account argument without a terminal and signs nobody out', async () => {
    const out = writer();
    const err = writer();
    const backend = fakePlanBackend({ accounts: [account({ label: 'work' })] });
    const code = await authLogout({ stdout: out, stderr: err, plan: backend.plan, isTerminal: false }, {});
    expect(code).not.toBe(0);
    expect(backend.planCalls.map((call) => call.route)).not.toContain('sign-out');
  });

  it('signs out the named account', async () => {
    const out = writer();
    const err = writer();
    const backend = fakePlanBackend({ accounts: [account({ label: 'work' })] });
    const code = await authLogout({ stdout: out, stderr: err, plan: backend.plan, isTerminal: false }, { account: 'work' });
    expect(code).toBe(0);
    expect(backend.planCalls.filter((call) => call.route === 'sign-out')).toEqual([{ route: 'sign-out', body: { profile: 'chatgpt', account: 'work' } }]);
  });
});
