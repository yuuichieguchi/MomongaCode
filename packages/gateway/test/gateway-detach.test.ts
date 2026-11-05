import { describe, expect, it } from 'vitest';
import { FAKE_DETERMINISTIC_REPLY, createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { outputText, postJson, readJson, readSse, registerCleanup, sseIterator, startGateway, userInput, type SseFrame } from './gateway-helpers.ts';
import { bigTextEvents, openRawPost } from './gateway-support.ts';
import { makeAdapter, startFake } from './cc-support.ts';

const events = (text: string) => textResponseEvents({ model: 'scripted-primary', chunks: [text] });
const body = { model: 'fast', input: userInput('hi') };
const streamBody = { ...body, stream: true };
const key = (value: string) => ({ 'idempotency-key': value });

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

const drain = async (iterator: AsyncIterator<SseFrame>): Promise<SseFrame[]> => {
  const frames: SseFrame[] = [];
  for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) frames.push(step.value);
  return frames;
};

describe('detached keyed runs', () => {
  it('runs a keyed stream to completion exactly once after its only client disconnects, then replays it', async () => {
    const plan = events('detached');
    const primary = createScriptedAdapter({ calls: [{ events: plan, gate: { name: 'g', afterEvents: 2 } }, { events: events('second') }] });
    const { client, socketPath } = await startGateway({ adapters: { primary } });
    registerCleanup(() => primary.release('g'));
    const raw = await openRawPost(socketPath, '/v1/responses', streamBody, { headers: key('d-1') });
    await waitFor(() => primary.calls[0]?.emitted === 2, { description: 'first two frames' });
    raw.socket.destroy();
    await settle();
    expect(primary.calls[0]?.signal.aborted).toBe(false);

    primary.release('g');
    await waitFor(() => primary.calls[0]?.outcome !== 'pending', { description: 'detached run finished' });
    expect(primary.calls[0]?.emitted).toBe(plan.length);
    expect(primary.calls[0]?.signal.aborted).toBe(false);

    const replayed = await readSse(await postJson(client, '/v1/responses', streamBody, key('d-1')));
    expect(replayed.map((frame) => frame.data.type)).toEqual(plan.map((event) => event.type));
    expect(replayed.at(-1)?.data.type).toBe('response.completed');
    expect(outputText(replayed.at(-1)?.data.response)).toBe('detached');
    expect(primary.calls).toHaveLength(1);
  });

  it('runs a keyed non-stream request to completion after disconnect and replays it non-streamed', async () => {
    const plan = events('unary detached');
    const primary = createScriptedAdapter({ calls: [{ events: plan, gate: { name: 'g', afterEvents: 1 } }] });
    const { client, socketPath } = await startGateway({ adapters: { primary } });
    registerCleanup(() => primary.release('g'));
    const raw = await openRawPost(socketPath, '/v1/responses', body, { headers: key('d-2') });
    await waitFor(() => primary.calls[0]?.emitted === 1);
    raw.socket.destroy();
    await settle();
    primary.release('g');
    await waitFor(() => primary.calls[0]?.outcome !== 'pending');
    expect(primary.calls[0]?.emitted).toBe(plan.length);
    expect(primary.calls[0]?.signal.aborted).toBe(false);
    const replayed = await readJson(await postJson(client, '/v1/responses', body, key('d-2')));
    expect(replayed.status).toBe(200);
    expect(outputText(replayed.body)).toBe('unary detached');
    expect(primary.calls).toHaveLength(1);
  });

  it('lets a request joining a detached run receive every frame from the first one, with one upstream call', async () => {
    const plan = events('joined late');
    const primary = createScriptedAdapter({ calls: [{ events: plan, gate: { name: 'g', afterEvents: 3 } }] });
    const { client, socketPath } = await startGateway({ adapters: { primary } });
    registerCleanup(() => primary.release('g'));
    const raw = await openRawPost(socketPath, '/v1/responses', streamBody, { headers: key('d-3') });
    await waitFor(() => primary.calls[0]?.emitted === 3);
    raw.socket.destroy();
    await settle();

    const joining = postJson(client, '/v1/responses', streamBody, key('d-3'));
    let arrived = false;
    const markArrived = (): void => {
      arrived = true;
    };
    void joining.then(markArrived, markArrived);
    await settle();
    const heldBeforeOutput = !arrived;
    primary.release('g');
    const joined = sseIterator(await joining);
    const first = await joined.next();
    expect(heldBeforeOutput).toBe(true);
    expect(first.done).not.toBe(true);
    const frames = [first.value as SseFrame, ...(await drain(joined))];
    expect(frames.map((frame) => frame.data.type)).toEqual(plan.map((event) => event.type));
    expect(frames.map((frame) => frame.data.sequence_number)).toEqual(plan.map((_, index) => index));
    expect(primary.calls).toHaveLength(1);
    expect(primary.calls[0]?.emitted).toBe(plan.length);
    expect(primary.calls[0]?.signal.aborted).toBe(false);
  });

  it('ends only the joiner when the joiner disconnects, and the leader still completes', async () => {
    const plan = events('leader survives');
    const primary = createScriptedAdapter({ calls: [{ events: plan, gate: { name: 'g', afterEvents: 2 } }] });
    const { client, socketPath } = await startGateway({ adapters: { primary } });
    registerCleanup(() => primary.release('g'));
    const leading = postJson(client, '/v1/responses', streamBody, key('d-4'));
    let arrived = false;
    const markArrived = (): void => {
      arrived = true;
    };
    void leading.then(markArrived, markArrived);
    await waitFor(() => primary.calls[0]?.emitted === 2, { description: 'the opening events' });
    const joiner = await openRawPost(socketPath, '/v1/responses', streamBody, { headers: key('d-4') });
    await settle();
    joiner.socket.destroy();
    await settle();
    const heldBeforeOutput = !arrived;
    expect(primary.calls[0]?.signal.aborted).toBe(false);
    primary.release('g');
    const leader = sseIterator(await leading);
    const rest = await drain(leader);
    expect(heldBeforeOutput).toBe(true);
    expect(rest.at(-1)?.data.type).toBe('response.completed');
    expect(primary.calls).toHaveLength(1);
    expect(primary.calls[0]?.emitted).toBe(plan.length);
    expect(primary.calls[0]?.signal.aborted).toBe(false);
  });

  it('ends only the joiner when the joiner deadline passes, and the run still commits', async () => {
    const plan = events('deadline joiner');
    const primary = createScriptedAdapter({ calls: [{ events: plan, gate: { name: 'g', afterEvents: 2 } }] });
    const { client, socketPath, timers } = await startGateway({ adapters: { primary } });
    registerCleanup(() => primary.release('g'));
    const raw = await openRawPost(socketPath, '/v1/responses', streamBody, { headers: key('d-5') });
    await waitFor(() => primary.calls[0]?.emitted === 2);
    raw.socket.destroy();
    await settle();

    const joining = postJson(client, '/v1/responses', body, { ...key('d-5'), 'momonga-deadline-ms': '500' });
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 500), { description: 'joiner deadline timer', maxTurns: 20_000 });
    timers.advance(500);
    const joinerResult = await readJson(await joining);
    expect(joinerResult.status).toBe(504);
    expect(joinerResult.body.error.code).toBe('deadline_exceeded');
    expect(primary.calls[0]?.signal.aborted).toBe(false);

    primary.release('g');
    await waitFor(() => primary.calls[0]?.outcome !== 'pending');
    expect(primary.calls[0]?.emitted).toBe(plan.length);
    expect(primary.calls[0]?.signal.aborted).toBe(false);
    const replayed = await readJson(await postJson(client, '/v1/responses', body, key('d-5')));
    expect(outputText(replayed.body)).toBe('deadline joiner');
    expect(primary.calls).toHaveLength(1);
  });

  it('aborts a detached run at detachedMaxMs and stores nothing', async () => {
    const primary = createScriptedAdapter({
      calls: [{ events: events('too slow'), gate: { name: 'never', afterEvents: 1 } }, { events: events('fresh') }],
    });
    const { client, socketPath, timers } = await startGateway({ adapters: { primary }, config: { detachedMaxMs: 60_000 } });
    registerCleanup(() => primary.release('never'));
    const raw = await openRawPost(socketPath, '/v1/responses', streamBody, { headers: key('d-6') });
    await waitFor(() => primary.calls[0]?.emitted === 1);
    raw.socket.destroy();
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 60_000), { description: 'detached max timer', maxTurns: 20_000 });
    timers.advance(59_999);
    expect(primary.calls[0]?.signal.aborted).toBe(false);
    timers.advance(1);
    await waitFor(() => primary.calls[0]?.outcome !== 'pending');
    expect(primary.calls[0]?.outcome).toBe('aborted');
    const again = await readJson(await postJson(client, '/v1/responses', body, key('d-6')));
    expect(outputText(again.body)).toBe('fresh');
    expect(primary.calls).toHaveLength(2);
  });

  it('aborts a keyed run that outgrew its frame buffer when its last subscriber leaves', async () => {
    const primary = createScriptedAdapter({
      calls: [{ events: bigTextEvents(10, 1000), gate: { name: 'g', afterEvents: 12 } }, { events: events('rerun') }],
    });
    const { client, socketPath } = await startGateway({ adapters: { primary }, config: { limits: { maxIdempotencyFrameBytes: 4000 } } });
    registerCleanup(() => primary.release('g'));
    const raw = await openRawPost(socketPath, '/v1/responses', streamBody, { headers: key('d-7') });
    await waitFor(() => primary.calls[0]?.emitted === 12, { description: 'frames past the cap' });
    const joiner = await readJson(await postJson(client, '/v1/responses', streamBody, key('d-7')));
    expect(joiner.status).toBe(409);
    expect(joiner.body.error.code).toBe('idempotency_key_in_progress');
    raw.socket.destroy();
    await waitFor(() => primary.calls[0]?.outcome !== 'pending', { description: 'unretained run aborted' });
    expect(primary.calls[0]?.outcome).toBe('aborted');
    const again = await readJson(await postJson(client, '/v1/responses', body, key('d-7')));
    expect(outputText(again.body)).toBe('rerun');
    expect(primary.calls).toHaveLength(2);
  });
});

describe('unkeyed runs', () => {
  it('still abort upstream when the client disconnects', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('abandoned'), gate: { name: 'g', afterEvents: 2 } }] });
    const { socketPath } = await startGateway({ adapters: { primary } });
    registerCleanup(() => primary.release('g'));
    const raw = await openRawPost(socketPath, '/v1/responses', streamBody);
    await waitFor(() => primary.calls[0]?.emitted === 2);
    raw.socket.destroy();
    await waitFor(() => primary.calls[0]?.outcome !== 'pending', { description: 'unkeyed run aborted' });
    expect(primary.calls[0]?.outcome).toBe('aborted');
    expect(primary.calls[0]?.signal.aborted).toBe(true);
  });
});

describe('POST /v1/momonga/responses/cancel', () => {
  const hanging = () => ({ kind: 'hang' as const, chunks: [{ delta: { role: 'assistant', content: 'partial' } }] });
  const ccTargets = { aliases: { fast: ['fm'] }, targets: { fm: { kind: 'chat-completions', model: 'system' } } };

  const cancel = (client: Awaited<ReturnType<typeof startGateway>>['client'], value?: string) =>
    client.request({ method: 'POST', path: '/v1/momonga/responses/cancel', headers: value === undefined ? {} : key(value) });

  it('aborts the in-flight run for the key, stores nothing, and a later request with the key runs again', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [hanging()] });
    const { client, socketPath } = await startGateway({ adapters: { fm: makeAdapter(fake) }, config: ccTargets });
    await openRawPost(socketPath, '/v1/responses', streamBody, { headers: key('c-1') });
    await waitFor(() => fake.openConnections() === 1 && fake.requests.length === 1, { description: 'upstream call open' });
    expect(fake.disconnects()).toBe(0);

    const cancelled = await readJson(await cancel(client, 'c-1'));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ cancelled: true });
    await waitFor(() => fake.disconnects() === 1, { description: 'upstream disconnected' });

    const again = await readJson(await postJson(client, '/v1/responses', body, key('c-1')));
    expect(again.status).toBe(200);
    expect(outputText(again.body)).toBe(FAKE_DETERMINISTIC_REPLY);
    expect(fake.requests.filter((request) => request.path === '/v1/chat/completions')).toHaveLength(2);
  });

  it('aborts a run that is detached from every client', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [hanging()] });
    const { client, socketPath } = await startGateway({ adapters: { fm: makeAdapter(fake) }, config: ccTargets });
    const raw = await openRawPost(socketPath, '/v1/responses', streamBody, { headers: key('c-2') });
    await waitFor(() => fake.openConnections() === 1 && fake.requests.length === 1);
    raw.socket.destroy();
    await settle();
    expect(fake.disconnects()).toBe(0);
    expect((await readJson(await cancel(client, 'c-2'))).body).toEqual({ cancelled: true });
    await waitFor(() => fake.disconnects() === 1, { description: 'upstream disconnected' });
  });

  it('answers cancelled false for a key with no in-flight run, including a completed one', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('done') }] });
    const { client } = await startGateway({ adapters: { primary } });
    expect((await readJson(await cancel(client, 'c-unknown'))).body).toEqual({ cancelled: false });
    await readJson(await postJson(client, '/v1/responses', body, key('c-3')));
    const response = await readJson(await cancel(client, 'c-3'));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ cancelled: false });
    const replayed = await readJson(await postJson(client, '/v1/responses', body, key('c-3')));
    expect(outputText(replayed.body)).toBe('done');
    expect(primary.calls).toHaveLength(1);
  });
});

describe('close() drain', () => {
  it('lets a detached keyed run finish within closeGraceMs and commit it', async () => {
    const plan = events('drained');
    const primary = createScriptedAdapter({ calls: [{ events: plan, gate: { name: 'g', afterEvents: 2 } }] });
    const first = await startGateway({ adapters: { primary }, config: { closeGraceMs: 750 } });
    registerCleanup(() => primary.release('g'));
    const raw = await openRawPost(first.socketPath, '/v1/responses', streamBody, { headers: key('x-1') });
    await waitFor(() => primary.calls[0]?.emitted === 2);
    raw.socket.destroy();
    await settle();

    const closing = first.gateway.close();
    await waitFor(() => first.timers.pending().some((timer) => timer.delayMs === 750), { description: 'close grace timer' });
    expect(primary.calls[0]?.signal.aborted).toBe(false);
    primary.release('g');
    await closing;
    expect(primary.calls[0]?.emitted).toBe(plan.length);
    expect(primary.calls[0]?.signal.aborted).toBe(false);
    expect(first.gateway.abandonedRuns).toBe(0);

    const successor = createScriptedAdapter({ calls: [{ events: events('should not run') }] });
    const second = await startGateway({ adapters: { primary: successor }, dir: first.dir, clock: first.clock });
    const replayed = await readJson(await postJson(second.client, '/v1/responses', body, key('x-1')));
    expect(outputText(replayed.body)).toBe('drained');
    expect(successor.calls).toHaveLength(0);
  });

  it('aborts a keyed run still in flight after closeGraceMs and leaves its key unstored', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('cut off'), gate: { name: 'never', afterEvents: 2 } }] });
    const first = await startGateway({ adapters: { primary }, config: { closeGraceMs: 750 } });
    registerCleanup(() => primary.release('never'));
    const raw = await openRawPost(first.socketPath, '/v1/responses', streamBody, { headers: key('x-2') });
    await waitFor(() => primary.calls[0]?.emitted === 2);
    raw.socket.destroy();
    await settle();

    const closing = first.gateway.close();
    await waitFor(() => first.timers.pending().some((timer) => timer.delayMs === 750), { description: 'close grace timer' });
    first.timers.advance(749);
    expect(primary.calls[0]?.signal.aborted).toBe(false);
    first.timers.advance(1);
    await closing;
    expect(primary.calls[0]?.signal.aborted).toBe(true);
    expect(first.gateway.abandonedRuns).toBe(1);

    const successor = createScriptedAdapter({ calls: [{ events: events('re-sent') }] });
    const second = await startGateway({ adapters: { primary: successor }, dir: first.dir, clock: first.clock });
    const again = await readJson(await postJson(second.client, '/v1/responses', body, key('x-2')));
    expect(outputText(again.body)).toBe('re-sent');
    expect(successor.calls).toHaveLength(1);
  });

  it('refuses new requests once draining starts', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('slow'), gate: { name: 'g', afterEvents: 1 } }] });
    const { gateway, socketPath, timers } = await startGateway({ adapters: { primary }, config: { closeGraceMs: 750 } });
    registerCleanup(() => primary.release('g'));
    const raw = await openRawPost(socketPath, '/v1/responses', streamBody, { headers: key('x-3') });
    await waitFor(() => primary.calls[0]?.emitted === 1);
    raw.socket.destroy();
    await settle();
    const closing = gateway.close();
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 750));
    const late = await openRawPost(socketPath, '/v1/responses', body, { headers: key('x-4') }).then(
      () => 'connected',
      () => 'refused',
    );
    expect(late).toBe('refused');
    primary.release('g');
    await closing;
    expect(primary.calls).toHaveLength(1);
  });
});
