import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, waitFor, testKernelLock } from '@momonga/testkit';
import { makeDir, outputText, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { openGatewayStore } from '../src/core/store.ts';
import { STORE_WORKER_CODE } from '../src/core/store-worker-code.generated.ts';
import { inspectProcessLock } from '@momonga/foundation';

describe('gateway persistence and lifecycle', () => {
  it('creates the database file 0600 in the directory it is given', async () => {
    const { dbPath } = await startGateway({ adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) } });
    expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  it('refuses a database directory that does not exist and does not create it', async () => {
    const missing = path.join(makeDir(), 'removed-home', 'state');

    await expect(openGatewayStore({ dbPath: path.join(missing, 'gateway.db'), code: STORE_WORKER_CODE, signal: new AbortController().signal })).rejects.toThrow(`database directory ${missing} does not exist`);
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
  });

  it('closes idempotently, aborts in-flight adapter calls, clears timers, and releases the socket', async () => {
    const primary = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['never'] }), gate: { name: 'held', afterEvents: 0 } }],
    });
    const { gateway, client, socketPath, timers } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const inFlight = postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi') }).then(
      async (response) => ({ status: response.status, text: await response.text() }),
      (error: unknown) => ({ error }),
    );
    await waitFor(() => primary.calls.length === 1);

    await gateway.close();
    await gateway.close();

    expect(primary.calls[0]?.signal.aborted).toBe(true);
    await waitFor(() => primary.calls[0]?.outcome === 'aborted');
    const settled = await inFlight;
    if ('status' in settled) expect(settled.status).not.toBe(200);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect((await inspectProcessLock(`${socketPath}.lock`, { mechanism: testKernelLock() })).state).toBe('free');
    expect(timers.pending()).toEqual([]);
  });

  it('releases the database and socket so a new gateway on the same paths replays a keyed answer', async () => {
    const first = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['remembered'] }) }] });
    const before = await startGateway({ adapters: { 'scripted/scripted-primary': first } });
    const body = { model: 'scripted/scripted-primary', input: userInput('q1') };
    const answered = await readJson(await postJson(before.client, '/v1/responses', body, { 'idempotency-key': 'k-restart' }));
    expect(answered.status).toBe(200);
    await before.client.close();
    await before.gateway.close();

    const second = createScriptedAdapter({ calls: [] });
    const after = await startGateway({ adapters: { 'scripted/scripted-primary': second }, dir: before.dir, clock: before.clock });
    const replayed = await readJson(await postJson(after.client, '/v1/responses', body, { 'idempotency-key': 'k-restart' }));
    expect(replayed.status).toBe(200);
    expect(outputText(replayed.body)).toBe('remembered');
    expect(second.calls).toEqual([]);
  });

  it('rejects construction when a model has no adapter', async () => {
    await expect(
      startGateway({
        adapters: { 'scripted/missing-adapter': createScriptedAdapter({ calls: [] }) },
        config: { targets: { 'scripted/m': {} } },
      }),
    ).rejects.toThrow('createGateway: model "scripted/m" has no adapter');
  });

  it('rejects construction when the fallback order names a model that is not configured', async () => {
    await expect(
      startGateway({ adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) }, config: { chains: { 'scripted/scripted-primary': ['scripted/scripted-primary', 'scripted/ghost'] } } }),
    ).rejects.toThrow('createGateway: the fallback order names "scripted/ghost", which is not a configured model');
  });
});
