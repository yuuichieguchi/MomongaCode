import { describe, expect, it } from 'vitest';
import type { SessionView } from '../src/client/views.ts';
import { reopenSessionCommand } from '@momonga/protocol';
import { SessionRefused, continuedSession, resolveSession } from '../src/run/resolve-session.ts';
import { SESSION } from './fake-backend.ts';

const stored = (sessions: readonly SessionView[]) => ({ listSessions: async (cwd?: string) => sessions.filter((session) => cwd === undefined || session.cwd === cwd) });

const session = (id: string, overrides: Partial<SessionView> = {}): SessionView => ({ ...SESSION, id, latestRunId: 'run-1', ...overrides });

const HERE = '/work/project';

describe('the reopen command (9.1)', () => {
  it('is momonga --resume with the full id', () => {
    expect(reopenSessionCommand('0123456789abcdef')).toBe('momonga --resume 0123456789abcdef');
  });

  it('opens the session with exactly that id', async () => {
    const sessions = stored([session('0123456789abcdef'), session('0123456789abcdef-2')]);

    expect((await resolveSession(sessions, HERE, '0123456789abcdef')).id).toBe('0123456789abcdef');
  });

  it('opens the one session a prefix of at least 8 characters names', async () => {
    const sessions = stored([session('0123456789abcdef'), session('fedcba9876543210')]);

    expect((await resolveSession(sessions, HERE, '01234567')).id).toBe('0123456789abcdef');
  });

  it('refuses an id no session has, and a prefix shorter than 8 characters', async () => {
    const sessions = stored([session('0123456789abcdef')]);

    await expect(resolveSession(sessions, HERE, 'ffffffff')).rejects.toThrow(new SessionRefused('No session has the id ffffffff.'));
    await expect(resolveSession(sessions, HERE, '0123456')).rejects.toThrow(new SessionRefused('No session has the id 0123456. A shortened id needs at least 8 characters.'));
  });

  it('refuses an ambiguous prefix with the matching ids', async () => {
    const sessions = stored([session('0123456789abcdef'), session('0123456700000000'), session('fedcba9876543210')]);

    await expect(resolveSession(sessions, HERE, '01234567')).rejects.toThrow(new SessionRefused('01234567 matches more than one session: 0123456789abcdef, 0123456700000000'));
  });

  it('refuses a session of another folder with the command that reopens it there', async () => {
    const sessions = stored([session('0123456789abcdef', { cwd: '/work/other' })]);

    await expect(resolveSession(sessions, HERE, '01234567')).rejects.toThrow(new SessionRefused('That session belongs to the folder /work/other. Run: cd /work/other && momonga --resume 0123456789abcdef'));
  });
});

describe('--continue (9.1)', () => {
  it('opens the newest session of this folder that has a run', async () => {
    const sessions = stored([session('old', { createdAt: 1 }), session('newest', { createdAt: 3 }), session('empty', { createdAt: 4, latestRunId: null }), session('elsewhere', { createdAt: 5, cwd: '/work/other' })]);

    expect((await continuedSession(sessions, HERE)).id).toBe('newest');
  });

  it('refuses when this folder has no session', async () => {
    await expect(continuedSession(stored([session('empty', { latestRunId: null })]), HERE)).rejects.toThrow(new SessionRefused('No session to continue in the folder /work/project.'));
  });
});
