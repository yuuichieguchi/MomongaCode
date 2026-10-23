import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AdapterCompactRequest, AdapterCompactResult, AdapterContext, ProviderAdapter } from '@momonga/gateway';
import { createScriptedAdapter, usageOf, waitFor } from '@momonga/testkit';
import { expectErrorBody, postJson, readJson, registerCleanup, startGateway, userInput, validator } from './gateway-helpers.ts';
import { openRawPost } from './gateway-support.ts';
import { startFake } from './cc-support.ts';

type GatedCompactAdapter = ProviderAdapter & {
  readonly compactSignals: AbortSignal[];
  readonly settled: Array<'completed' | 'failed' | 'aborted'>;
  release(): void;
};

const createGatedCompactAdapter = (summaries: Array<string | Error>, gated = true): GatedCompactAdapter => {
  const base = createScriptedAdapter({ calls: [] });
  const compactSignals: AbortSignal[] = [];
  const settled: Array<'completed' | 'failed' | 'aborted'> = [];
  let open = !gated;
  const waiters: Array<() => void> = [];
  return {
    ...base,
    compactSignals,
    settled,
    release: () => {
      open = true;
      for (const wake of waiters.splice(0)) wake();
    },
    compact: async (_request: AdapterCompactRequest, ctx: AdapterContext): Promise<AdapterCompactResult> => {
      const index = compactSignals.length;
      compactSignals.push(ctx.signal);
      try {
        if (!open) {
          await new Promise<void>((resolve, reject) => {
            waiters.push(resolve);
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
          });
        }
        const planned = summaries[index];
        if (planned === undefined) throw new Error(`no compact plan for call #${index + 1}`);
        if (planned instanceof Error) throw planned;
        settled.push('completed');
        return { summary: planned, usage: usageOf(40, 8) };
      } catch (error) {
        settled.push(ctx.signal.aborted ? 'aborted' : 'failed');
        throw error;
      }
    },
  };
};

const compactBody = { model: 'fast', input: userInput('summarise this conversation') };
const key = (value: string) => ({ 'idempotency-key': value });
const compact = (client: Awaited<ReturnType<typeof startGateway>>['client'], keyValue: string, payload: unknown = compactBody) =>
  postJson(client, '/v1/responses/compact', payload, key(keyValue)).then(readJson);

const summaryOf = (resource: { output: Array<{ type: string; encrypted_content?: string }> }): string => {
  const item = resource.output.find((entry) => entry.type === 'compaction');
  const payload = (item?.encrypted_content ?? '').split('.')[0] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).summary;
};

describe('gateway.db migration v2', () => {
  it('creates the compactions table with key, digest, resource_json, created_at and expires_at', async () => {
    const primary = createGatedCompactAdapter([]);
    const { dbPath } = await startGateway({ adapters: { primary } });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const columns = db.prepare('PRAGMA table_info(compactions)').all() as Array<{ name: string; pk: number }>;
      expect(columns.map((column) => column.name)).toEqual(['key', 'digest', 'resource_json', 'created_at', 'expires_at']);
      expect(columns.filter((column) => column.pk > 0).map((column) => column.name)).toEqual(['key']);
      const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
      expect(versions.map((row) => row.version)).toEqual([1, 2]);
    } finally {
      db.close();
    }
  });
});

describe('POST /v1/responses/compact with Idempotency-Key', () => {
  it('returns the stored resource for the same key and body without a second upstream call', async () => {
    const primary = createGatedCompactAdapter(['first summary', 'second summary'], false);
    const { client } = await startGateway({ adapters: { primary } });
    const first = await compact(client, 'cp-1');
    const second = await compact(client, 'cp-1');
    expect(first.status).toBe(200);
    expect(validator.validate('CompactResource', first.body).errors).toEqual([]);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(summaryOf(second.body)).toBe('first summary');
    expect(primary.compactSignals).toHaveLength(1);
  });

  it('treats a key-order-only difference in the body as the same digest', async () => {
    const primary = createGatedCompactAdapter(['canonical', 'unexpected'], false);
    const { client } = await startGateway({ adapters: { primary } });
    const first = await compact(client, 'cp-2', '{"model":"fast","input":"hello"}');
    const second = await compact(client, 'cp-2', '{"input":"hello","model":"fast"}');
    expect(second.body).toEqual(first.body);
    expect(primary.compactSignals).toHaveLength(1);
  });

  it('joins a concurrent duplicate onto the one in-flight call', async () => {
    const primary = createGatedCompactAdapter(['shared summary', 'unexpected']);
    const { client } = await startGateway({ adapters: { primary } });
    registerCleanup(() => primary.release());
    const first = compact(client, 'cp-3');
    await waitFor(() => primary.compactSignals.length === 1, { description: 'first compact call' });
    const second = compact(client, 'cp-3');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(primary.compactSignals).toHaveLength(1);
    primary.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(summaryOf(a.body)).toBe('shared summary');
    expect(primary.compactSignals).toHaveLength(1);
  });

  it('rejects the same key with a different body with 422 idempotency_key_reused', async () => {
    const primary = createGatedCompactAdapter(['first', 'unexpected'], false);
    const { client } = await startGateway({ adapters: { primary } });
    expect((await compact(client, 'cp-4')).status).toBe(200);
    const reused = await compact(client, 'cp-4', { model: 'fast', input: userInput('a different conversation') });
    expect(reused.status).toBe(422);
    expectErrorBody(reused.body, { type: 'invalid_request', code: 'idempotency_key_reused', param: null });
    expect(primary.compactSignals).toHaveLength(1);
  });

  it('does not store a failed result, so a retry with the key calls upstream again', async () => {
    const primary = createGatedCompactAdapter([new Error('compact blew up'), 'recovered'], false);
    const { client } = await startGateway({ adapters: { primary } });
    expect((await compact(client, 'cp-5')).status).not.toBe(200);
    const retried = await compact(client, 'cp-5');
    expect(retried.status).toBe(200);
    expect(summaryOf(retried.body)).toBe('recovered');
    expect(primary.compactSignals).toHaveLength(2);
  });

  it('keeps running a keyed compaction after its client disconnects and stores the result', async () => {
    const primary = createGatedCompactAdapter(['detached summary', 'unexpected']);
    const { client, socketPath } = await startGateway({ adapters: { primary } });
    registerCleanup(() => primary.release());
    const raw = await openRawPost(socketPath, '/v1/responses/compact', compactBody, { headers: key('cp-6') });
    await waitFor(() => primary.compactSignals.length === 1, { description: 'compact call started' });
    raw.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(primary.compactSignals[0]?.aborted).toBe(false);
    primary.release();
    await waitFor(() => primary.settled.length === 1, { description: 'compact settled' });
    expect(primary.settled).toEqual(['completed']);
    const replayed = await compact(client, 'cp-6');
    expect(replayed.status).toBe(200);
    expect(summaryOf(replayed.body)).toBe('detached summary');
    expect(primary.compactSignals).toHaveLength(1);
  });

  it('still aborts an unkeyed compaction when its client disconnects', async () => {
    const primary = createGatedCompactAdapter(['never']);
    const { socketPath } = await startGateway({ adapters: { primary } });
    const raw = await openRawPost(socketPath, '/v1/responses/compact', compactBody);
    await waitFor(() => primary.compactSignals.length === 1);
    raw.socket.destroy();
    await waitFor(() => primary.settled.length === 1, { description: 'unkeyed compact aborted' });
    expect(primary.settled).toEqual(['aborted']);
  });

  it('serves the stored resource after a gateway restart on the same database', async () => {
    const primary = createGatedCompactAdapter(['durable summary'], false);
    const first = await startGateway({ adapters: { primary } });
    const original = await compact(first.client, 'cp-7');
    expect(original.status).toBe(200);
    await first.gateway.close();

    const successor = createGatedCompactAdapter(['must not run'], false);
    const second = await startGateway({ adapters: { primary: successor }, dir: first.dir, clock: first.clock });
    const replayed = await compact(second.client, 'cp-7');
    expect(replayed.status).toBe(200);
    expect(replayed.body).toEqual(original.body);
    expect(successor.compactSignals).toHaveLength(0);
  });

  it('expires a stored compaction after idempotency.ttlMs', async () => {
    const primary = createGatedCompactAdapter(['before expiry', 'after expiry'], false);
    const { client, clock } = await startGateway({ adapters: { primary }, config: { idempotency: { ttlMs: 60_000 } } });
    await compact(client, 'cp-8');
    clock.advance(59_999);
    expect(summaryOf((await compact(client, 'cp-8')).body)).toBe('before expiry');
    clock.advance(2);
    expect(summaryOf((await compact(client, 'cp-8')).body)).toBe('after expiry');
    expect(primary.compactSignals).toHaveLength(2);
  });

  it('validates the stored resource on read and names the compactions table and key when it is malformed', async () => {
    const primary = createGatedCompactAdapter(['stored', 'unexpected'], false);
    const { client, dbPath } = await startGateway({ adapters: { primary } });
    await compact(client, 'cp-9');
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare('UPDATE compactions SET resource_json = ? WHERE key = ?').run('{"object":"response.compaction"}', 'cp-9');
    } finally {
      db.close();
    }
    const replayed = await compact(client, 'cp-9');
    expect(replayed.status).toBe(500);
    expect(replayed.body.error.message).toContain('compactions');
    expect(replayed.body.error.message).toContain('cp-9');
    expect(primary.compactSignals).toHaveLength(1);
  });

  it('keeps compactions without a key independent', async () => {
    const primary = createGatedCompactAdapter(['one', 'two'], false);
    const { client } = await startGateway({ adapters: { primary } });
    const one = await readJson(await postJson(client, '/v1/responses/compact', compactBody));
    const two = await readJson(await postJson(client, '/v1/responses/compact', compactBody));
    expect(summaryOf(one.body)).toBe('one');
    expect(summaryOf(two.body)).toBe('two');
    expect(primary.compactSignals).toHaveLength(2);
  });
});

const createUpstreamCompactAdapter = (socketPath: string): ProviderAdapter & { readonly compactCalls: { count: number } } => {
  const base = createScriptedAdapter({ calls: [] });
  const compactCalls = { count: 0 };
  return {
    ...base,
    compactCalls,
    compact: async (_request: AdapterCompactRequest, ctx: AdapterContext): Promise<AdapterCompactResult> => {
      compactCalls.count += 1;
      const payload = JSON.stringify({ model: 'system', messages: [{ role: 'user', content: 'summarise' }] });
      const text = await new Promise<string>((resolve, reject) => {
        const request = http.request(
          { socketPath, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, signal: ctx.signal },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            response.on('error', reject);
          },
        );
        request.on('error', reject);
        request.end(payload);
      });
      return { summary: JSON.parse(text).choices[0].message.content, usage: usageOf(40, 8) };
    },
  };
};

describe('POST /v1/momonga/responses/cancel for keyed compactions', () => {
  it('aborts the in-flight compaction upstream, stores nothing, and a re-request runs fresh', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'hang' }] });
    const primary = createUpstreamCompactAdapter(fake.socketPath);
    const { client } = await startGateway({ adapters: { primary } });
    registerCleanup(() => fake.close());
    const pending = compact(client, 'cp-cancel');
    await waitFor(() => fake.openConnections() === 1 && fake.requests.length === 1, { description: 'upstream compact call open' });
    expect(fake.disconnects()).toBe(0);

    const cancelled = await readJson(
      await client.request({ method: 'POST', path: '/v1/momonga/responses/cancel', headers: key('cp-cancel') }),
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ cancelled: true });
    await waitFor(() => fake.disconnects() === 1, { description: 'upstream disconnected' });
    expect((await pending).status).not.toBe(200);

    const again = await compact(client, 'cp-cancel');
    expect(again.status).toBe(200);
    expect(summaryOf(again.body)).toBe('This is a deterministic reply.');
    expect(primary.compactCalls.count).toBe(2);
    expect(fake.requests).toHaveLength(2);
  });
});

const createAbortIgnoringCompactAdapter = (): ProviderAdapter & { readonly signals: AbortSignal[]; release(): void } => {
  const base = createScriptedAdapter({ calls: [] });
  const signals: AbortSignal[] = [];
  const waiters: Array<() => void> = [];
  let open = false;
  return {
    ...base,
    signals,
    release: () => {
      open = true;
      for (const wake of waiters.splice(0)) wake();
    },
    compact: async (_request: AdapterCompactRequest, ctx: AdapterContext): Promise<AdapterCompactResult> => {
      signals.push(ctx.signal);
      if (!open) await new Promise<void>((resolve) => waiters.push(resolve));
      return { summary: 'late summary', usage: usageOf(40, 8) };
    },
  };
};

describe('a cancelled keyed compaction stays tracked until it settles', () => {
  const startCancelled = async (keyValue: string) => {
    const primary = createAbortIgnoringCompactAdapter();
    const harness = await startGateway({ adapters: { primary }, config: { closeGraceMs: 750 } });
    registerCleanup(() => primary.release());
    const raw = await openRawPost(harness.socketPath, '/v1/responses/compact', compactBody, { headers: key(keyValue) });
    await waitFor(() => primary.signals.length === 1, { description: 'compact call started' });
    raw.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cancelled = await readJson(
      await harness.client.request({ method: 'POST', path: '/v1/momonga/responses/cancel', headers: key(keyValue) }),
    );
    expect(cancelled.body).toEqual({ cancelled: true });
    expect(primary.signals[0]?.aborted).toBe(true);
    return { primary, ...harness };
  };

  it('makes close() wait for it within closeGraceMs', async () => {
    const { primary, gateway, timers } = await startCancelled('cp-gw3-1');
    let closed = false;
    const closing = gateway.close().then(() => {
      closed = true;
    });
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 750), { description: 'close grace timer' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    primary.release();
    await closing;
    expect(gateway.abandonedRuns).toBe(0);
  });

  it('counts it in abandonedRuns when closeGraceMs expires', async () => {
    const { gateway, timers } = await startCancelled('cp-gw3-2');
    const closing = gateway.close();
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 750), { description: 'close grace timer' });
    timers.advance(750);
    await closing;
    expect(gateway.abandonedRuns).toBe(1);
  });
});

describe('compact digest over the parsed request', () => {
  it('shares one stored result between bodies differing only in key order and whitespace, including nested items', async () => {
    const primary = createGatedCompactAdapter(['parsed digest', 'unexpected'], false);
    const { client } = await startGateway({ adapters: { primary } });
    const compact1 =
      '{"model":"fast","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"instructions":"be brief"}';
    const compact2 =
      '{\n  "instructions" : "be brief",\n  "input" : [ { "content" : [ { "text" : "hi", "type" : "input_text" } ], "role" : "user", "type" : "message" } ],\n  "model" : "fast"\n}';
    const first = await compact(client, 'cp-gs1', compact1);
    const second = await compact(client, 'cp-gs1', compact2);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(primary.compactSignals).toHaveLength(1);
  });
});
