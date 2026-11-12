import { describe, expect, it } from 'vitest';
import * as nodePorts from '../src/update/node-ports.ts';

describe('the stall limit of an update transfer is the setting update.stallTimeoutMs', () => {
  it('builds every bound of the transfer from the setting, and no fixed stall constant remains', () => {
    expect(nodePorts.transferOptionsOf(90_000)).toEqual({ connectReplyTimeoutMs: 90_000, headersTimeout: 90_000, bodyTimeout: 90_000 });
    expect(Object.keys(nodePorts)).not.toContain('TRANSFER_STALL_TIMEOUT_MS');
  });
});
