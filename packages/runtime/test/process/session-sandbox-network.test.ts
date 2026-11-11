import { describe, expect, it } from 'vitest';
import { sandboxNetworkOf } from '../../src/process/tool-runtime.ts';

describe('the network of a sandboxed command', () => {
  it('is the value of the session when the command line gave one, although the user setting allows the network', () => {
    expect(sandboxNetworkOf({ sandboxNetwork: 'deny' }, 'allow')).toBe('deny');
  });

  it('is the user setting when the session has none', () => {
    expect(sandboxNetworkOf({ sandboxNetwork: null }, 'allow')).toBe('allow');
  });
});

describe('the values a session create request takes', () => {
  it('are the values of the setting', async () => {
    const { SESSION_SANDBOX_NETWORKS } = await import('@momonga/protocol');
    const { SANDBOX_NETWORK_SETTINGS } = await import('@momonga/foundation');
    expect([...SESSION_SANDBOX_NETWORKS]).toEqual([...SANDBOX_NETWORK_SETTINGS]);
  });
});
