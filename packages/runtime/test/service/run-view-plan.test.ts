import { describe, expect, it } from 'vitest';
import type { Run } from '@momonga/store';
import { toRunView } from '../../src/service/views.ts';
import { startService } from './helpers.ts';

const PLAN = { profile: 'chatgpt', account: 'work' };

describe('the run view carries the plan account of the run error', () => {
  it('toRunView keeps error.plan', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const created = await env.createRun(session.id);
    const stored = env.store.getRun(created.id) as Run;
    const error = { code: 'sign_in_required', message: 'The ChatGPT sign-in expired.', plan: PLAN };

    expect(toRunView({ ...stored, status: 'FAILED', error } as Run).error).toEqual(error);
  });
});
