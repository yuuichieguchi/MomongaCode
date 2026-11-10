import { RequestError } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { RUN_STOPPED_CODE, stopReasonOf } from '../src/acp/stop-reason.ts';
import { runView } from './fake-backend.ts';

describe('ACP reports a usage stop as stopped: usage_limit (P3c, M7)', () => {
  it('fails the prompt with the stop reason usage_limit, as it does timeout and loop', () => {
    const run = runView({ id: 'run-7', status: 'STOPPED', stopReason: 'usage_limit' as never });
    let failure: unknown;
    try {
      stopReasonOf(run);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RequestError);
    expect(failure).toMatchObject({ code: RUN_STOPPED_CODE, data: { runId: 'run-7', status: 'STOPPED', stopReason: 'usage_limit' } });
    expect((failure as Error).message).toContain('stopped: usage_limit');
  });
});
