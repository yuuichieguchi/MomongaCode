import { describe, expect, it } from 'vitest';
import type { SessionView } from '../src/client/views.ts';
import { reopenSessionCommand } from '@momonga/protocol';
import { SessionRefused, continuedSession, resolveSession } from '../src/run/resolve-session.ts';
import { SESSION } from './fake-backend.ts';

const stored = (sessions: readonly SessionView[]) => ({ listSessions: async (cwd?: string) => sessions.filter((session) => cwd === undefined || session.cwd === cwd) });

const session = (id: string, overrides: Partial<SessionView> = {}): SessionView => ({ ...SESSION, id, latestRunId: `run-of-${id}`, latestRunAt: 1, ...overrides });

const HERE = '/work/project';

describe('the reopen command (9.1)', () => {
  it('is momonga --resume with the full id', () => {
    expect(reopenSessionCommand('0123456789abcdef')).toBe('momonga --resume 0123456789abcdef');
  });

  it('opens the session with exactly that id', async () => {
    const sessions = stored([session('0123456789abcdef'), session('0123456789abcdef-2')]);

    expect((await resolveSession(sessions, HERE, '0123456789abcdef', 'linux')).id).toBe('0123456789abcdef');
  });

  it('opens the one session a prefix of at least 8 characters names', async () => {
    const sessions = stored([session('0123456789abcdef'), session('fedcba9876543210')]);

    expect((await resolveSession(sessions, HERE, '01234567', 'linux')).id).toBe('0123456789abcdef');
  });

  it('refuses an id no session has, and a prefix shorter than 8 characters', async () => {
    const sessions = stored([session('0123456789abcdef')]);

    await expect(resolveSession(sessions, HERE, 'ffffffff', 'linux')).rejects.toThrow(new SessionRefused('No session has the id ffffffff.'));
    await expect(resolveSession(sessions, HERE, '0123456', 'linux')).rejects.toThrow(new SessionRefused('No session has the id 0123456. A shortened id needs at least 8 characters.'));
  });

  it('refuses an ambiguous prefix with the matching ids', async () => {
    const sessions = stored([session('0123456789abcdef'), session('0123456700000000'), session('fedcba9876543210')]);

    await expect(resolveSession(sessions, HERE, '01234567', 'linux')).rejects.toThrow(new SessionRefused('01234567 matches more than one session: 0123456789abcdef, 0123456700000000'));
  });

  it('opens the one session of this folder a prefix names, whatever sessions of other folders share it, after one read of the list', async () => {
    const lists: (string | undefined)[] = [];
    const all = [session('0123456789abcdef'), session('0123456700000000', { cwd: '/work/other' })];
    const sessions = { listSessions: async (cwd?: string) => (lists.push(cwd), all.filter((each) => cwd === undefined || each.cwd === cwd)) };

    expect((await resolveSession(sessions, HERE, '01234567', 'linux')).id).toBe('0123456789abcdef');
    expect(lists).toEqual([HERE]);
  });

  it('refuses a session of another folder with the command that reopens it there', async () => {
    const sessions = stored([session('0123456789abcdef', { cwd: '/work/other' })]);

    await expect(resolveSession(sessions, HERE, '01234567', 'linux')).rejects.toThrow(new SessionRefused('That session belongs to the folder /work/other. Run: cd /work/other && momonga --resume 0123456789abcdef'));
  });
});

describe('--continue (9.1)', () => {
  it('opens the session of this folder whose run is the latest, whenever the session was made', async () => {
    const sessions = stored([
      session('worked-in-last', { createdAt: 1, latestRunAt: 9 }),
      session('made-last', { createdAt: 3, latestRunAt: 4 }),
      session('empty', { createdAt: 5, latestRunId: null, latestRunAt: null }),
      session('elsewhere', { createdAt: 6, latestRunAt: 10, cwd: '/work/other' }),
    ]);

    expect((await continuedSession(sessions, HERE)).id).toBe('worked-in-last');
  });

  it('refuses when this folder has no session', async () => {
    await expect(continuedSession(stored([session('empty', { latestRunId: null, latestRunAt: null })]), HERE)).rejects.toThrow(new SessionRefused('No session to continue in the folder /work/project.'));
  });
});
