import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { getJson, outputText, postJson, readJson, readSse, registerCleanup, startGateway, switchableRole, userInput } from '../gateway-helpers.ts';
import { bigTextEvents, createHangingAdapter, openRawPost, openUnreadStream } from '../gateway-support.ts';

const CLOSE_GRACE_MS = 750;
const DEADLINE_MS = 5000;

const HELD_EVENT_COUNT = textResponseEvents({ model: 'scripted-primary', chunks: ['x'] }).length;

const heldCall = (text: string) => ({ events: textResponseEvents({ model: 'scripted-primary', chunks: [text] }), gate: { name: 'held', afterEvents: 1 } });

const heldGateway = async (text: string) => {
  const role = switchableRole('serving');
  const primary = createScriptedAdapter({ calls: [heldCall(text)] });
  const harness = await startGateway({ adapters: { primary }, role, config: { closeGraceMs: CLOSE_GRACE_MS } });
  registerCleanup(() => primary.release('held'));
  return { ...harness, primary, role };
};

describe('a call accepted before retirement is never cut (design-update 18.1 rule 3a, 20.53)', () => {
  it('completes a unary call with its normal answer after the role became retiring, counts it as active, and closes its connection after the response', async () => {
    const { client, primary, role } = await heldGateway('kept whole');
    const answering = postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') });
    await waitFor(() => primary.calls[0]?.emitted === 1, { description: 'the call to be accepted and held upstream' });

    role.become('retiring');
    const health = await getJson(client, '/v1/momonga/health');
    expect([health.body.state, health.body.activeRequests]).toEqual(['retiring', 1]);

    primary.release('held');
    const answered = await readJson(await answering);
    expect(answered.status).toBe(200);
    expect(outputText(answered.body)).toBe('kept whole');
    expect(answered.headers['connection']).toBe('close');
    expect(primary.calls[0]?.outcome).not.toBe('aborted');
    expect(primary.calls[0]?.emitted).toBe(HELD_EVENT_COUNT);
    expect((await getJson(client, '/v1/momonga/health')).body.activeRequests).toBe(0);
  });

  it('streams a call accepted before retirement to its terminal event', async () => {
    const { client, primary, role } = await heldGateway('streamed whole');
    const streaming = postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true });
    await waitFor(() => primary.calls[0]?.emitted === 1, { description: 'the stream to be accepted and held upstream' });

    role.become('retiring');
    primary.release('held');
    const frames = await readSse(await streaming);

    expect(frames.at(-1)?.data.type).toBe('response.completed');
    expect(outputText(frames.at(-1)?.data.response)).toBe('streamed whole');
    expect(primary.calls[0]?.outcome).not.toBe('aborted');
    expect(primary.calls[0]?.emitted).toBe(HELD_EVENT_COUNT);
  });

  it('applies no close grace to a stream held past closeGraceMs while retiring, and ends it by its own momonga-deadline-ms', async () => {
    const role = switchableRole('serving');
    const primary = createHangingAdapter(bigTextEvents(80, 100_000));
    const { timers, socketPath } = await startGateway({ adapters: { primary }, role, config: { closeGraceMs: CLOSE_GRACE_MS } });
    await openRawPost(socketPath, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true }, { paused: true, headers: { 'momonga-deadline-ms': String(DEADLINE_MS) } });
    await waitFor(() => primary.pulled.count >= 5, { description: 'adapter streaming' });

    role.become('retiring');
    expect(timers.pending().some((timer) => timer.delayMs === CLOSE_GRACE_MS)).toBe(false);
    timers.advance(CLOSE_GRACE_MS);
    expect(primary.signals[0]?.aborted).toBe(false);

    timers.advance(DEADLINE_MS - CLOSE_GRACE_MS);
    await waitFor(() => primary.signals[0]?.aborted === true, { description: 'the stream to end by its own deadline' });
  });

  it('keeps the grace and the abort of the user stop for a retiring gateway', async () => {
    const role = switchableRole('serving');
    const primary = createHangingAdapter(bigTextEvents(80, 100_000));
    const { gateway, timers, socketPath } = await startGateway({ adapters: { primary }, role, config: { closeGraceMs: CLOSE_GRACE_MS } });
    await openUnreadStream(socketPath, { model: 'fast', input: userInput('hi'), stream: true });
    await waitFor(() => primary.pulled.count >= 5, { description: 'adapter streaming' });
    role.become('retiring');

    const closing = gateway.close();
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === CLOSE_GRACE_MS), { description: 'close grace timer' });
    timers.advance(CLOSE_GRACE_MS);
    await closing;

    expect(primary.signals[0]?.aborted).toBe(true);
    expect(gateway.abandonedRuns).toBe(1);
  });
});
