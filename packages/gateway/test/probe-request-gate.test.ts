import http from 'node:http';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemTiming } from '@momonga/foundation';
import { createTempDir } from '@momonga/testkit';
import { PROBE_STEP_SPEED_MULTIPLE, ProbeTimeoutError, createProbeClient, speedStepBound } from '../src/probe/client.ts';
import { createRequestGate } from '../src/probe/request-gate.ts';
import { until } from './gateway-process-helpers.ts';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

type Seen = { arrived: number; aborted: number };

const serverOf = async (answer: (index: number, response: http.ServerResponse) => void): Promise<{ socketPath: string; seen: Seen }> => {
  const directory = createTempDir();
  const socketPath = join(directory, 's.sock');
  const seen: Seen = { arrived: 0, aborted: 0 };
  const server = http.createServer((request, response) => {
    const index = seen.arrived;
    seen.arrived += 1;
    request.resume();
    response.on('close', () => {
      if (!response.writableFinished) seen.aborted += 1;
    });
    answer(index, response);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, seen };
};

const answerJson = (response: http.ServerResponse): void => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end('{"ok":true}');
};

describe('the request gate of a server: a measurement yields to the person', () => {
  it('gives a measurement its turn only while no request of the person is in flight', async () => {
    const gate = createRequestGate();
    const release = gate.person();
    let turned = false;
    const turn = gate.turn(new AbortController().signal).then((given) => {
      turned = true;
      return given;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(turned).toBe(false);

    release();
    const given = await turn;
    expect(given.yielded.aborted).toBe(false);
    given.end();
  });

  it('takes the turn back from a measurement when a request of the person arrives', async () => {
    const gate = createRequestGate();
    const given = await gate.turn(new AbortController().signal);

    const release = gate.person();

    expect(given.yielded.aborted).toBe(true);
    release();
    given.end();
  });

  it('aborts the measurement request in flight when the person sends one, and sends it again once the person is served', async () => {
    const { socketPath, seen } = await serverOf((index, response) => {
      if (index > 0) answerJson(response);
    });
    const gate = createRequestGate();
    const client = createProbeClient({ kind: 'unix', socketPath }, { signal: undefined, bound: speedStepBound(20_000), timers: systemTiming, gate });
    closers.push(() => client.close());

    const measured = client.post('chat', {});
    await until(() => seen.arrived === 1, 'the measurement request reached the server');
    const release = gate.person();
    await until(() => seen.aborted === 1, 'the measurement request was aborted');
    expect(seen.arrived).toBe(1);

    release();
    expect((await measured).status).toBe(200);
    expect(seen.arrived).toBe(2);
  });
});

describe('a request sent again after it gave way', () => {
  it('is counted once per send, so a metered bound sees both sends', async () => {
    const { socketPath, seen } = await serverOf((index, response) => {
      if (index > 0) answerJson(response);
    });
    const gate = createRequestGate();
    const sends: unknown[] = [];
    const client = createProbeClient({ kind: 'unix', socketPath }, { signal: undefined, bound: speedStepBound(20_000), timers: systemTiming, gate, onSend: (body) => sends.push(body) });
    closers.push(() => client.close());

    const measured = client.post('chat', { n: 1 });
    await until(() => seen.arrived === 1, 'the measurement request reached the server');
    gate.person()();
    await measured;

    expect(sends).toEqual([{ n: 1 }, { n: 1 }]);
  });
});

describe('the bound of a measurement step comes from the observed speed of the model', { timeout: 30_000 }, () => {
  it('is the cap until the first answer, which carries the load of the model; then the slowest observed speed times the stated multiple for the size of the request, never above the cap', () => {
    const bound = speedStepBound(120_000);
    expect(bound.currentMs(100)).toBe(120_000);

    bound.observe(40_000, 100);
    expect(bound.currentMs(100)).toBe(120_000);

    bound.observe(1_000, 100);
    expect(bound.currentMs(100)).toBe(1_000 * PROBE_STEP_SPEED_MULTIPLE);
    expect(bound.currentMs(10)).toBe(1_000 * PROBE_STEP_SPEED_MULTIPLE);
    expect(bound.currentMs(200)).toBe(2_000 * PROBE_STEP_SPEED_MULTIPLE);

    bound.observe(500, 100);
    expect(bound.currentMs(100)).toBe(1_000 * PROBE_STEP_SPEED_MULTIPLE);

    bound.observe(100_000, 100);
    expect(bound.currentMs(100)).toBe(120_000);
  });

  it('ends a request at the derived bound once an answer was observed', async () => {
    const { socketPath } = await serverOf((index, response) => {
      if (index < 2) answerJson(response);
    });
    const bound = speedStepBound(20_000);
    const client = createProbeClient({ kind: 'unix', socketPath }, { signal: undefined, bound, timers: systemTiming, gate: createRequestGate() });
    closers.push(() => client.close());

    await client.post('chat', {});
    await client.post('chat', {});
    const derived = bound.currentMs(JSON.stringify({}).length);
    expect(derived).toBeLessThan(20_000);

    const failure = await client.post('chat', {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProbeTimeoutError);
    expect((failure as ProbeTimeoutError).timeoutMs).toBe(derived);
  });
});
