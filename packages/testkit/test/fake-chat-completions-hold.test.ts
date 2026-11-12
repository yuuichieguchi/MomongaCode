import http from 'node:http';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { FAKE_DETERMINISTIC_REPLY, startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer, FakeResponseHold } from '@momonga/testkit';

const HOLD_WAIT = { timeoutMs: 5000, description: 'the held completion' } as const;

const servers: FakeChatCompletionsServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const complete = (socketPath: string): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify({ model: 'system', messages: [{ role: 'user', content: 'hi' }] }));
  });

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  return Promise.race([promise.then(() => true), Promise.resolve(false)]);
};

describe('fake chat completions response hold', () => {
  it('holds the next completion until release, after recording the request', async () => {
    const fake = await startFakeChatCompletions({ scenario: 'none' });
    servers.push(fake);
    const hold = fake.hold();
    const response = complete(fake.socketPath);
    const arrived = await hold.waitForRequest(HOLD_WAIT);
    expect(arrived).toMatchObject({ method: 'POST', path: '/v1/chat/completions' });
    expect(fake.requests).toHaveLength(1);
    expect(await settled(response)).toBe(false);
    hold.release();
    const answered = await response;
    expect(answered.status).toBe(200);
    expect(answered.body.choices[0].message.content).toBe(FAKE_DETERMINISTIC_REPLY);
  });

  it('applies each hold to one request in order and leaves later requests unheld', async () => {
    const fake = await startFakeChatCompletions({ scenario: 'none', maxConcurrency: 4 });
    servers.push(fake);
    const first = fake.hold();
    const held = complete(fake.socketPath);
    await first.waitForRequest(HOLD_WAIT);
    expect((await complete(fake.socketPath)).status).toBe(200);
    expect(await settled(held)).toBe(false);
    first.release();
    expect((await held).status).toBe(200);
  });

  it('close releases a held request', async () => {
    const fake = await startFakeChatCompletions({ scenario: 'none' });
    const hold = fake.hold();
    const response = complete(fake.socketPath).catch((error: unknown) => error);
    await hold.waitForRequest(HOLD_WAIT);
    await fake.close();
    await response;
  });

  it('names its bound and description in every wait for the held request', () => {
    expectTypeOf<Parameters<FakeResponseHold['waitForRequest']>>().toEqualTypeOf<[{ readonly timeoutMs: number; readonly description: string }]>();
  });

  it('fails a wait for a request that does not come within its bound with its description', async () => {
    const fake = await startFakeChatCompletions({ scenario: 'none' });
    servers.push(fake);
    const hold = fake.hold();
    await expect(hold.waitForRequest({ timeoutMs: 20, description: 'the request that never comes' })).rejects.toThrow('the request that never comes did not happen within 20 ms');
    hold.release();
  });
});
