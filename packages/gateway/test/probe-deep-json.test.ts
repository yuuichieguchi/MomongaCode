import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProbe } from '@momonga/gateway';
import { MALFORMED_JSON } from '../src/adapters/shared/json.ts';
import { hostProbePorts } from './probe-ports-support.ts';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const DEPTH = 10_000;

const serverListing = async (listing: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'probe-deep-'));
  const socketPath = join(directory, 's.sock');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(listing);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return socketPath;
};

describe('a probe step whose reply is not usable JSON fails with the one typed error', () => {
  it.each([
    ['too deep', `${'['.repeat(DEPTH)}${']'.repeat(DEPTH)}`],
    ['not JSON', 'the listing is down for maintenance'],
  ])('fails the measurement with malformed_json when the model listing is %s', async (_kind, listing) => {
    const socketPath = await serverListing(listing);

    const failure = await runProbe({ socketPath, ports: hostProbePorts, samples: 1 }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: MALFORMED_JSON });
  });
});
