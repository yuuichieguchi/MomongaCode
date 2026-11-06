import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROFILE_ID, START_MS, editRecord, planError, readRecord, recordFileOf, signedIn, startHarness, CONDITION_WAIT } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const harness = async (): Promise<Harness> => {
  const h = await startHarness();
  harnesses.push(h);
  return h;
};

const work = [{ profile: PROFILE_ID, account: 'work' }];

describe('startup of the session engine', () => {
  it('sweeps stale temp files in the sessions directory and keeps the records', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const stale = path.join(h.paths.sessions, `${path.basename(recordFileOf(h, 'work'))}.4f2a.tmp`);
    await fs.writeFile(stale, 'partial', { mode: 0o600 });
    await h.reopen({ accounts: work });
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'active' });
  });

  it('a record with a loose mode is store_unreadable with a warning, never needs_sign_in, and startup still resolves', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await fs.chmod(recordFileOf(h, 'work'), 0o644);
    await h.reopen({ accounts: work });
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    expect(source.status().state).toBe('store_unreadable');
    expect(source.status().cause).toBeDefined();
    expect(h.warnings).toHaveLength(1);
    expect(source.health()).toMatchObject({ ok: false, reason: 'store_unreadable' });
    expect((await planError(source.read(new AbortController().signal))).code).toBe('plan_store_unreadable');
  });

  it('a corrupt record is store_unreadable too', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await fs.writeFile(recordFileOf(h, 'work'), '{"version":', { mode: 0o600 });
    await h.reopen({ accounts: work });
    expect(h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).status().state).toBe('store_unreadable');
  });

  it('a missing record is absent: not signed in, and no warning', async () => {
    const h = await harness();
    await h.reopen({ accounts: work });
    expect(h.warnings).toEqual([]);
    expect((await planError(h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).read(new AbortController().signal))).code).toBe('sign_in_required');
  });

  it('a record left in signing_out resumes the revocation and ends registered', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    await editRecord(h, 'work', (record) => ({ ...record, state: 'signing_out' }));
    await h.reopen({ accounts: work });
    await expect.poll(async () => (await readRecord(h, 'work'))?.['state'], CONDITION_WAIT).toBe('registered');
    expect(h.auth.calls.revoke).toBe(1);
    expect(h.auth.records.find((record) => record.path.endsWith('/revoke'))?.form['token']).toBe(signIn.tokens.refresh_token);
  });

  it('a record with pendingRefresh is marked ambiguous: its terminal answer keeps the server code and sets interrupted', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const installed = await readRecord(h, 'work');
    await editRecord(h, 'work', (record) => ({ ...record, pendingRefresh: { generation: installed?.['generation'], startedAt: START_MS } }));
    await h.reopen({ accounts: work });
    h.auth.scriptToken('refresh_token', [{ kind: 'error', code: 'invalid_grant' }]);
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    await source.rejected(installed?.['generation'] as number, new AbortController().signal);
    expect(source.status()).toMatchObject({ state: 'needs_sign_in', cause: 'invalid_grant' });
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'needs_sign_in', cause: 'invalid_grant', interrupted: true });
  });
});
