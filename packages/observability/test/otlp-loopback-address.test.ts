import http from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { findOutboundError } from '@momonga/foundation';
import type { OutboundNetwork } from '@momonga/foundation';
import { createOtlpAgent } from '../src/otlp-agent.ts';

const TIMEOUT_MS = 5_000;
const NETWORK: OutboundNetwork = { config: { caFiles: [] }, trust: { sources: [], failures: [] } };

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const lookupAnswering = (address: string): { lookup: LookupFunction; asked: string[] } => {
  const asked: string[] = [];
  const lookup = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void): void => {
    asked.push(hostname);
    queueMicrotask(() => (options.all === true ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4)));
  };
  return { lookup: lookup as unknown as LookupFunction, asked };
};

const startCollector = async (): Promise<{ port: number; requests: () => number }> => {
  let count = 0;
  const server = http.createServer((_request, response) => {
    count += 1;
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, requests: () => count };
};

const post = (url: URL, agent: http.Agent): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', agent }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end('{}');
  });

describe('the OTLP agent connects a collector named as this machine only to a loopback address', () => {
  it('refuses with the not-loopback failure when the name resolves to a public address', async () => {
    const collector = await startCollector();
    const url = new URL(`http://x.localhost:${collector.port}/v1/traces`);
    const { lookup, asked } = lookupAnswering('203.0.113.9');
    const { agent, labelled } = createOtlpAgent(url, NETWORK, TIMEOUT_MS, lookup);
    closers.push(async () => agent.destroy());

    const error = await post(url, agent).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(findOutboundError(labelled(error as Error))?.failure).toEqual({ kind: 'not-loopback', host: 'x.localhost', address: '203.0.113.9' });
    expect(asked).toEqual(['x.localhost']);
    expect(collector.requests()).toBe(0);
  });

  it('connects when the name resolves to a loopback address', async () => {
    const collector = await startCollector();
    const url = new URL(`http://x.localhost:${collector.port}/v1/traces`);
    const { lookup } = lookupAnswering('127.0.0.1');
    const { agent } = createOtlpAgent(url, NETWORK, TIMEOUT_MS, lookup);
    closers.push(async () => agent.destroy());

    expect(await post(url, agent)).toBe(200);
    expect(collector.requests()).toBe(1);
  });
});
