import { describe, expect, it } from 'vitest';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';
import type { Harness } from './helpers.ts';

const PLAN = { profile: 'chatgpt', account: 'work' };

const failedRun = async (h: Harness, error: { code: string; message: string; plan?: { profile: string; account: string } }): Promise<string> => {
  const run = enqueue(h.store, newSession(h.store).id);
  const claim = mustClaim(h.store, 'w1');
  expect((await h.store.transition(claim, ['RUNNING'], 'FAILED', { error })).kind).toBe('ok');
  return run.id;
};

describe('a stored run error keeps the plan account of the failure', () => {
  it('reads back the plan of a run error written with one', async () => {
    const h = harness();
    const error = { code: 'sign_in_required', message: 'm', plan: PLAN };
    const id = await failedRun(h, error);
    expect(h.store.getRun(id)?.error).toEqual(error);
  });

  it('refuses a stored plan without string profile and account as a corrupt row', async () => {
    const h = harness();
    const id = await failedRun(h, { code: 'c', message: 'm' });
    rawDb(h.dbPath).prepare('UPDATE runs SET error_json = ? WHERE id = ?').run('{"code":"c","message":"m","plan":{"profile":"p"}}', id);
    expect(() => h.store.getRun(id)).toThrow('column error_json must hold a plan with string profile and account when it holds one');
  });

  it('reads a run error stored without plan with no plan key', async () => {
    const h = harness();
    const id = await failedRun(h, { code: 'c', message: 'm' });
    const error = h.store.getRun(id)?.error;
    expect(error).toEqual({ code: 'c', message: 'm' });
    expect(error !== null && error !== undefined && 'plan' in error).toBe(false);
  });
});
