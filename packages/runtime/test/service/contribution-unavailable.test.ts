import { describe, expect, it } from 'vitest';
import { JournalThreadError } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { contributionUnavailable } from '../../src/service/errors.ts';
import { startService } from './helpers.ts';

const rejectingResolutions = (failure: Error) => (store: RuntimeStore): RuntimeStore =>
  new Proxy(store, {
    get: (target, key, receiver) => {
      if (key === 'resolveApproval') return async () => Promise.reject(failure);
      return Reflect.get(target, key, receiver);
    },
  });

describe('a journal thread failure seen by an HTTP client', () => {
  it('builds a retryable 503 with the stable code contribution_unavailable', () => {
    const error = contributionUnavailable('the contribution of run run-1 could not be measured');

    expect(error).toMatchObject({ status: 503, type: 'server_error', code: 'contribution_unavailable', headers: { 'retry-after': '1' } });
  });

  it('answers 503 contribution_unavailable with retry-after, and does not report it as an internal error', async () => {
    const failure = new JournalThreadError('the journal thread exited');
    const env = await startService({ wrapStore: rejectingResolutions(failure) });

    const response = await env.http('POST', '/v1/approvals/approval-1', { body: { optionId: 'allow_once' } });

    expect(response.status).toBe(503);
    expect(response.json.error).toMatchObject({ code: 'contribution_unavailable', type: 'server_error' });
    expect(response.headers['retry-after']).toBe('1');
    expect(env.errors).toEqual([]);
  });
});
