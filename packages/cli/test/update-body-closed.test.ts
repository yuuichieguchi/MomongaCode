import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runUpdate } from '../src/commands/update.ts';
import type { UpdateHttp, UpdatePorts } from '../src/update/ports.ts';
import { assetNameFor } from '../src/update/source.ts';
import { checksumListing } from './fake-release-server.ts';
import { NEW_BINARY, setupUpdate } from './update-harness.ts';
import type { UpdateHarness } from './update-harness.ts';
import { waitFor } from '@momonga/testkit';

type Opened = { url: string; body: Readable };

const trackBodies = (harness: UpdateHarness): Opened[] => {
  const opened: Opened[] = [];
  const inner: UpdateHttp = harness.ports.http;
  (harness.wiring.ports as { http: UpdatePorts['http'] }).http = {
    get: async (url, request) => {
      const response = await inner.get(url, request);
      opened.push({ url, body: response.body as unknown as Readable });
      return response;
    },
  };
  return opened;
};

const runAndCheckBodies = async (harness: UpdateHarness, opened: Opened[], checkOnly = false): Promise<void> => {
  await runUpdate(harness.wiring, { write: () => undefined }, { checkOnly, interrupt: new AbortController().signal }).then(
    () => undefined,
    () => undefined,
  );
  expect(opened.length, 'the consumer opened at least one response').toBeGreaterThan(0);
  await waitFor(() => opened.every(({ body }) => body.closed), { description: `the close of the bodies of ${opened.filter(({ body }) => !body.closed).map(({ url }) => url).join(', ')}` });
  for (const { url, body } of opened) expect(body.closed, `the body of ${url} is closed after the consumer returned`).toBe(true);
};

const assetOf = (harness: UpdateHarness): string => assetNameFor(harness.ports.platform, harness.ports.arch);

const PATHS: ReadonlyArray<{ label: string; checkOnly?: boolean; arrange(harness: UpdateHarness): void }> = [
  { label: 'a successful update', arrange: (h) => h.server.publish('v2.0.0', { [assetOf(h)]: NEW_BINARY }) },
  { label: 'a check only', checkOnly: true, arrange: (h) => h.server.publish('v2.0.0', { [assetOf(h)]: NEW_BINARY }) },
  {
    label: 'a failing release lookup',
    arrange: (h) => {
      h.server.latestStatus = 500;
    },
  },
  {
    label: 'a release lookup that is not JSON',
    arrange: (h) => {
      h.server.publish('v2.0.0', { [assetOf(h)]: NEW_BINARY });
      h.server.latestBody = 'not json';
    },
  },
  {
    label: 'a release lookup without tag_name',
    arrange: (h) => {
      h.server.publish('v2.0.0', { [assetOf(h)]: NEW_BINARY });
      h.server.latestBody = JSON.stringify({ name: 'x' });
    },
  },
  { label: 'a missing SHA256SUMS', arrange: (h) => h.server.publish('v2.0.0', { [assetOf(h)]: NEW_BINARY }, { checksums: undefined }) },
  { label: 'a missing signature', arrange: (h) => h.server.publish('v2.0.0', { [assetOf(h)]: NEW_BINARY }, { signature: undefined }) },
  {
    label: 'a rejected signature',
    arrange: (h) => {
      h.server.publish('v2.0.0', { [assetOf(h)]: NEW_BINARY });
      h.control.signature = { exitCode: 255, stdout: '', stderr: 'Could not verify signature.\n' };
    },
  },
  { label: 'a malformed SHA256SUMS listing', arrange: (h) => h.server.publish('v2.0.0', { [assetOf(h)]: NEW_BINARY }, { checksums: 'not a listing\n' }) },
  { label: 'a SHA256SUMS without this asset', arrange: (h) => h.server.publish('v2.0.0', { [assetOf(h)]: NEW_BINARY }, { checksums: checksumListing({ 'momonga-other-platform': NEW_BINARY }) }) },
  {
    label: 'a checksum mismatch',
    arrange: (h) => h.server.publish('v2.0.0', { [assetOf(h)]: NEW_BINARY }, { checksums: checksumListing({ [assetOf(h)]: Buffer.from('what the publisher signed') }) }),
  },
  {
    label: 'a missing asset',
    arrange: (h) => {
      h.server.publish('v2.0.0', { [assetOf(h)]: NEW_BINARY });
      h.server.files.delete(`v2.0.0/${assetOf(h)}`);
    },
  },
  {
    label: 'a download interrupted mid-body',
    arrange: (h) => {
      h.server.publish('v2.0.0', { [assetOf(h)]: NEW_BINARY });
      const asset = h.server.files.get(`v2.0.0/${assetOf(h)}`);
      if (asset === undefined) throw new Error('asset was not published');
      asset.interruptAfterBytes = 7;
    },
  },
  {
    label: 'an unusable candidate',
    arrange: (h) => {
      h.server.publish('v2.0.0', { [assetOf(h)]: NEW_BINARY });
      h.control.reportedVersion = '9.9.9';
    },
  },
];

describe('every update consumer path ends each response body, so the network lease is released (design-settings-live 15.6, leasedUpdateHttp)', () => {
  for (const path of PATHS) {
    it(`${path.label}: every response body is closed after the consumer returns or throws`, async (context) => {
      const harness = await setupUpdate(context);
      const opened = trackBodies(harness);
      path.arrange(harness);
      await runAndCheckBodies(harness, opened, path.checkOnly === true);
    });
  }
});
