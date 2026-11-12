import { until } from './gateway-process-helpers.ts';
import { systemTiming } from '@momonga/foundation';
import http from 'node:http';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, createTempDir, hostTimers } from '@momonga/testkit';
import { PROBE_REPLY_MAX_BYTES, ProbeReplyTooLargeError, ProbeTimeoutError, createProbeClient, fixedStepBound } from '../src/probe/client.ts';
import { PERSON_TRAFFIC } from '../src/probe/request-gate.ts';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const serverAnswering = async (write: (response: http.ServerResponse) => void): Promise<string> => {
  const directory = createTempDir();
  const socketPath = join(directory, 's.sock');
  const server = http.createServer((_request, response) => write(response));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return socketPath;
};

const endless = (response: http.ServerResponse): void => {
  response.writeHead(200, { 'content-type': 'application/json' });
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const pump = (): void => {
    while (response.write(chunk)) {
      if (response.destroyed) return;
    }
    response.once('drain', pump);
  };
  response.on('error', () => undefined);
  pump();
};

describe('the probe client reads a reply only up to its one cap', { timeout: 30_000 }, () => {
  it('ends an endless reply at the cap with a typed error', async () => {
    const socketPath = await serverAnswering(endless);
    const client = createProbeClient({ kind: 'unix', socketPath }, { signal: undefined, bound: fixedStepBound(20_000), timers: systemTiming, gate: PERSON_TRAFFIC });
    closers.push(() => client.close());
    const failure = await client.post('chat', {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProbeReplyTooLargeError);
    expect(String(failure)).toContain(String(PROBE_REPLY_MAX_BYTES));
  });

  it('reads a reply under the cap in full', async () => {
    const body = JSON.stringify({ data: 'x'.repeat(100_000) });
    const socketPath = await serverAnswering((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    });
    const client = createProbeClient({ kind: 'unix', socketPath }, { signal: undefined, bound: fixedStepBound(20_000), timers: systemTiming, gate: PERSON_TRAFFIC });
    closers.push(() => client.close());
    const result = await client.get('models');
    expect(result.status).toBe(200);
    expect(result.text).toBe(body);
  });

  it('bounds a step on the timer port it is given', async () => {
    const socketPath = await serverAnswering(() => undefined);
    const timers = createFakeTimers(createFakeClock(0));
    const client = createProbeClient({ kind: 'unix', socketPath }, { signal: undefined, bound: fixedStepBound(600_000), timers: timers, gate: PERSON_TRAFFIC });
    closers.push(() => client.close());
    const failure = client.get('models').then(
      () => undefined,
      (error: unknown) => error,
    );
    await until(() => timers.pending().length > 0, 'the step bound is armed on the timer port');
    timers.advance(600_000);
    expect(await failure).toBeInstanceOf(ProbeTimeoutError);
  });
});
