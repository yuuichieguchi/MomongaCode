import { describe, expect, it } from 'vitest';
describe('the values a session create request takes', () => {
  it('are the values of the setting', async () => {
    const { SESSION_SANDBOX_NETWORKS } = await import('@momonga/protocol');
    const { SANDBOX_NETWORK_SETTINGS } = await import('@momonga/foundation');
    expect([...SESSION_SANDBOX_NETWORKS]).toEqual([...SANDBOX_NETWORK_SETTINGS]);
  });
});
