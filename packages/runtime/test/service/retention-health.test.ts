import { describe, expect, it } from 'vitest';
import type { RetentionStatusView } from '@momonga/protocol';
import { startService } from './helpers.ts';

const STATUS: RetentionStatusView = { days: 30, lastSweep: { at: '2026-11-17T00:00:00.000Z', sessionsDeleted: 2, runsPurged: 3, blobsCollected: 4 } };

describe('the health of the runtime shows the retention status', () => {
  it('shows the period and the last sweep', async () => {
    const env = await startService({ retention: () => STATUS });

    expect((await env.http('GET', '/v1/health')).json.retention).toEqual(STATUS);
  });

  it('shows no retention status when the service has none to give', async () => {
    const env = await startService();

    expect((await env.http('GET', '/v1/health')).json).not.toHaveProperty('retention');
  });
});
