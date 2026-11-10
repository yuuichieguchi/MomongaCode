import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { waitFor } from '@momonga/testkit';
import { startGateway, userInput } from './gateway-helpers.ts';
import { bigTextEvents, createHangingAdapter, openUnreadStream } from './gateway-support.ts';
import { inspectProcessLock } from '@momonga/foundation';

describe('close() with a non-reading client and an adapter that ignores its signal', () => {
  it('resolves after closeGraceMs, removes the socket and lock, leaves no timers, and reports abandoned runs', async () => {
    const primary = createHangingAdapter(bigTextEvents(80, 100_000));
    const { gateway, timers, socketPath } = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, config: { closeGraceMs: 750 } });
    await openUnreadStream(socketPath, { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true });
    await waitFor(() => primary.pulled.count >= 5, { description: 'adapter streaming' });

    const closing = gateway.close();
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 750), { description: 'close grace timer' });
    timers.advance(750);
    await closing;

    expect(primary.signals[0]?.aborted).toBe(true);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect((await inspectProcessLock(`${socketPath}.lock`)).state).toBe('free');
    expect(timers.pending()).toEqual([]);
    expect(gateway.abandonedRuns).toBe(1);
  });

  it('does not leave the grace timer pending when everything settles in time', async () => {
    const primary = createHangingAdapter([]);
    const { gateway, timers } = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, config: { closeGraceMs: 750 } });
    await gateway.close();
    expect(timers.pending()).toEqual([]);
    expect(gateway.abandonedRuns).toBe(0);
  });
});
