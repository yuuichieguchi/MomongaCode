import { describe, expect, it } from 'vitest';
import { waitFor } from '@momonga/testkit';
import { startGateway, userInput } from './gateway-helpers.ts';
import { bigTextEvents, createHangingAdapter, openUnreadStream } from './gateway-support.ts';

describe('close() with the values of the stop', () => {
  it('a close grace of 0 closes without waiting for in-flight calls and cancels them', async () => {
    const primary = createHangingAdapter(bigTextEvents(80, 100_000));
    const { gateway, timers, clock, socketPath } = await startGateway({ adapters: { primary }, config: { closeGraceMs: 750 } });
    await openUnreadStream(socketPath, { model: 'fast', input: userInput('hi'), stream: true });
    await waitFor(() => primary.pulled.count >= 5, { description: 'adapter streaming' });

    const began = clock.now();
    let closed = false;
    const closing = gateway.close({ closeGraceMs: 0, managedServerStopGraceMs: 0, drainTimeoutMs: 300_000, mcpCloseGraceMs: 30_000 }).finally(() => {
      closed = true;
    });
    await waitFor(
      () => {
        if (timers.pending().some((timer) => timer.delayMs === 0)) timers.advance(0);
        return closed;
      },
      { description: 'the close to end with no grace' },
    );
    await closing;
    expect(clock.now()).toBe(began);
    expect(primary.signals[0]?.aborted).toBe(true);
  });
});
