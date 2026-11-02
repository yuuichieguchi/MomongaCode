import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { outputText, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { inspectProcessLock } from '@momonga/foundation';

describe('gateway persistence and lifecycle', () => {
  it('creates the database directory 0700 and the database file 0600', async () => {
    const { dbPath } = await startGateway({ adapters: { primary: createScriptedAdapter({ calls: [] }) } });
    expect(fs.statSync(path.dirname(dbPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  it('closes idempotently, aborts in-flight adapter calls, clears timers, and releases the socket', async () => {
    const primary = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['never'] }), gate: { name: 'held', afterEvents: 0 } }],
    });
    const { gateway, client, socketPath, timers } = await startGateway({ adapters: { primary } });
    const inFlight = postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }).then(
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
    expect((await inspectProcessLock(`${socketPath}.lock`)).state).toBe('free');
    expect(timers.pending()).toEqual([]);
  });

  it('releases the database and socket so a new gateway on the same paths serves stored responses', async () => {
    const first = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['remembered'] }) }] });
    const before = await startGateway({ adapters: { primary: first } });
    const stored = await readJson(await postJson(before.client, '/v1/responses', { model: 'fast', input: userInput('q1'), store: true }));
    expect(stored.status).toBe(200);
    await before.client.close();
    await before.gateway.close();

    const second = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['continued'] }) }] });
    const after = await startGateway({ adapters: { primary: second }, dir: before.dir, clock: before.clock });
    const followUp = await readJson(
      await postJson(after.client, '/v1/responses', { model: 'fast', input: userInput('q2'), previous_response_id: stored.body.id }),
    );
    expect(followUp.status).toBe(200);
    expect(outputText(followUp.body)).toBe('continued');
    expect(second.calls[0]?.request.input).toEqual([...userInput('q1'), ...stored.body.output, ...userInput('q2')]);
  });

  it('rejects construction when a target has no adapter keyed by its name', async () => {
    await expect(
      startGateway({
        adapters: { 'missing-adapter': createScriptedAdapter({ calls: [] }) },
        config: { aliases: { fast: ['primary'] }, targets: { primary: { model: 'm' } } },
      }),
    ).rejects.toThrow(/"primary"/);
  });

  it('rejects construction when an alias references an unknown target', async () => {
    await expect(
      startGateway({ adapters: { primary: createScriptedAdapter({ calls: [] }) }, config: { aliases: { fast: ['ghost'] } } }),
    ).rejects.toThrow(/ghost/);
  });
});
