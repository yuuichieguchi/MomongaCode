import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { PROBE_METHOD_VERSION, runProbe } from '@momonga/gateway';
import { startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { FM_PROBE_ROUTES } from './fm-record-support.ts';
import { probePortsAt } from './probe-ports-support.ts';

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const KNOWN_REQUEST_DIGESTS: Readonly<Record<number, string>> = {
  1: '2eba6dccf9cb71711251926e08c4e1e1ced08fcf720ac88b650328b89263bc92',
  2: '3305d855cc65fca9cfdf159ee2749a7ea6f43c63665faed95146c70f84c67136',
  3: 'c8b7dc4bf3639b56268cab2bc21b40e9d090f22ac87f59e720b768540810ce6b',
};

const requestDigestOfProbe = async (): Promise<string> => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', contextSizeExposure: 'models', contextWindow: 8192 });
  servers.push(fake);
  await runProbe({ socketPath: fake.socketPath, managed: FM_PROBE_ROUTES, samples: 2, ports: probePortsAt(() => new Date('2026-11-06T00:00:00.000Z')) });
  const bodies = fake.requests.filter((request) => request.path === '/v1/chat/completions').map((request) => canonicalJson(request.body)).sort();
  return sha256Hex(canonicalJson(bodies));
};

describe('PROBE_METHOD_VERSION guards the requests the probe sends', () => {
  it('pins the digest of the requests sent to the scripted fake to the current probe method', async () => {
    expect(await requestDigestOfProbe()).toBe(KNOWN_REQUEST_DIGESTS[PROBE_METHOD_VERSION]);
  });

  it('is the same digest on a second run, so nothing in the requests depends on time or on a generated id', async () => {
    expect(await requestDigestOfProbe()).toBe(await requestDigestOfProbe());
  });
});
