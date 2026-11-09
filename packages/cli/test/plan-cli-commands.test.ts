import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { authLogout, authStatus, nextAccountLabel } from '../src/commands/auth.ts';
import { describeRunError } from '../src/policy-messages.ts';
import { SHELL_SLASH_COMMANDS } from '../src/tui/commands/shell-commands.ts';
import { dismissNotice, readDismissedNotices } from '../src/tui/dismissed-notices.ts';
import { account, fakePlanBackend } from './fake-plan-gateway.tsx';
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

  it('names momonga auth login in a headless run', () => {
    const lines = describeRunError(expired, 'headless');
    expect(lines[0]).toMatch(/^ChatGPT sign-in expired · Run momonga auth login\b/);
    expect(lines[0]).not.toContain('/login');
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
      ],
    });
    const code = await authStatus({ stdout: out, plan: backend.plan }, { json: false });
    expect(code).toBe(0);
    const lines = out.written.join('').split('\n');
    const lineOf = (label: string): string => lines.find((line) => line.includes(`${label} `) || line.endsWith(label)) ?? '';
    expect(lineOf('home')).toContain('home@example.com');
    expect(lineOf('home')).toMatch(/^\s*\*/);
    expect(lineOf('home')).toContain('active');
    expect(lineOf('paused')).toContain('paused by limit');
    expect(lineOf('paused')).not.toMatch(/^\s*\*/);
    expect(lineOf('expired')).toContain('sign-in required');
    expect(lineOf('off')).toContain('plan use not enabled');
    expect(lineOf('gone')).toContain('signed out');
    expect(out.written.join('')).toContain('https://chatgpt.com/settings/usage');
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
