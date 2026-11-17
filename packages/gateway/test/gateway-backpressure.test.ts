import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { SSE_EVENT_MAX_BYTES } from '@momonga/foundation';
import { createScriptedAdapter, waitFor } from '@momonga/testkit';
import { postJson, readJson, readSse, sseIterator, startGateway, userInput } from './gateway-helpers.ts';
import { bigTextEvents } from './gateway-support.ts';

const SLOW_READER_CHUNK_BYTES = Math.floor(SSE_EVENT_MAX_BYTES / 4 / 200);
const WRITE_BLOCK_BYTES = 16 * 1024;
const WRITE_ATTEMPTS_BOUND = 100_000;
const STREAM_TO_CAPACITY_RATIO = 4;
const QUEUED_BEYOND_CAPACITY_BYTES = 64 * 1024;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const writableCapacityBytes = async (): Promise<number> => {
  const server = net.createServer();
  const accepted = new Promise<net.Socket>((resolve) => server.once('connection', resolve));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
  client.on('error', () => undefined);
  client.pause();
  const writer = await accepted;
  writer.on('error', () => undefined);
  const block = Buffer.alloc(WRITE_BLOCK_BYTES, 0x61);
  let written = 0;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt >= WRITE_ATTEMPTS_BOUND) throw new Error('the socket never blocked a writer that does not stop');
    written += block.length;
    if (!writer.write(block)) break;
  }
  const capacity = written - writer.writableLength;
  writer.destroy();
  client.destroy();
  server.close();
  return capacity;
};

describe('streaming backpressure', () => {
  it('stops producing for a slow reader before the stream is produced, and within what the socket takes', async () => {
    const capacity = await writableCapacityBytes();
    const chunks = Math.ceil((STREAM_TO_CAPACITY_RATIO * capacity) / SLOW_READER_CHUNK_BYTES);
    const primary = createScriptedAdapter({ calls: [{ events: bigTextEvents(chunks, SLOW_READER_CHUNK_BYTES) }] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const response = await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true });
    const frames = sseIterator(response);
    await frames.next();
    await pause(300);
    const emitted = primary.calls[0]?.emitted ?? 0;
    expect(emitted).toBeLessThan(chunks);
    expect(emitted * SLOW_READER_CHUNK_BYTES).toBeLessThanOrEqual(capacity + QUEUED_BEYOND_CAPACITY_BYTES);
    let count = 1;
    for (let step = await frames.next(); step.done !== true; step = await frames.next()) count += 1;
    expect(count).toBeGreaterThan(emitted);
  });
});

describe('idempotent frame cap', () => {
  const body = { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true };
  const key = { 'idempotency-key': 'cap-1' };

  it('finishes the leader, does not persist the result, and rejects late joiners with 409 idempotency_key_in_progress', async () => {
    const events = bigTextEvents(10, 1000);
    const primary = createScriptedAdapter({
      calls: [{ events, gate: { name: 'g', afterEvents: 12 } }, { events: bigTextEvents(10, 1000) }],
    });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, config: { limits: { maxIdempotencyFrameBytes: 4000 } } });
    const leaderResponse = await postJson(client, '/v1/responses', body, key);
    const leader = sseIterator(leaderResponse);
    for (let index = 0; index < 8; index += 1) await leader.next();
    await waitFor(() => primary.calls[0]?.emitted === 12);

    const joiner = await readJson(await postJson(client, '/v1/responses', body, key));
    expect(joiner.status).toBe(409);
    expect(joiner.body.error.code).toBe('idempotency_key_in_progress');

    primary.release('g');
    let frames = 8;
    for (let step = await leader.next(); step.done !== true; step = await leader.next()) frames += 1;
    expect(frames).toBe(events.length);

    const again = await readSse(await postJson(client, '/v1/responses', body, key));
    expect(again.at(-1)?.data.type).toBe('response.completed');
    expect(primary.calls).toHaveLength(2);
  });
});
