import { describe, expect, it } from 'vitest';
import { HTTP_FIXTURE_LEGACY_VERSION, HTTP_FIXTURE_MODERN_VERSION } from '@momonga/testkit';
import { isTransientRemoteFailure } from '@momonga/mcp';
import { createFakeClock } from '@momonga/testkit';
import { NEVER_ABORTED } from './mcp-harness.ts';
import { makeRemoteConnection, observedTimers, startHttpFixture, textOf } from './remote-harness.ts';

describe('streamable HTTP, protocol 2026-07-28', () => {
  it('negotiates the modern era and carries the per-request metadata headers', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    const tools = await connection.listTools();
    expect(tools.map((tool) => tool.name)).toContain('echo');
    expect(connection.protocolEra).toBe('modern');
    expect(connection.protocolVersion).toBe(HTTP_FIXTURE_MODERN_VERSION);

    const result = await connection.callTool({ name: 'echo', arguments: { text: 'hi' }, signal: NEVER_ABORTED, traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' });
    expect(textOf(result)).toBe('hi');
    const call = fixture.rpcRecords('tools/call')[0];
    expect(call?.headers['mcp-method']).toBe('tools/call');
    expect(call?.headers['mcp-name']).toBe('echo');
    expect(call?.headers['mcp-protocol-version']).toBe(HTTP_FIXTURE_MODERN_VERSION);
    expect(call?.headers['mcp-session-id']).toBeUndefined();
    expect((call?.rpc?.params['_meta'] as Record<string, unknown>)['traceparent']).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
  });

  it('mirrors an x-mcp-header parameter into its request header', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    const result = await connection.callTool({ name: 'region_echo', arguments: { region: 'us-west1' }, signal: NEVER_ABORTED });
    expect(textOf(result)).toBe('region us-west1');
    expect(fixture.rpcRecords('tools/call')[0]?.headers['mcp-param-region']).toBe('us-west1');
  });

  it('does not re-issue a call whose response stream broke and classifies the failure as transient', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    const failure = await connection.callTool({ name: 'stream_drop', arguments: {}, signal: NEVER_ABORTED }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(isTransientRemoteFailure(failure)).toBe(true);
    expect(fixture.rpcRecords('tools/call').filter((record) => record.rpc?.params['name'] === 'stream_drop')).toHaveLength(1);
    expect(fixture.records.filter((record) => record.httpMethod === 'GET')).toHaveLength(0);
  });

  it('cancels a pending call by closing its response stream and sends no cancellation notification', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    const controller = new AbortController();
    const pending = connection.callTool({ name: 'slow', arguments: {}, signal: controller.signal });
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await fixture.until(() => fixture.rpcRecords('tools/call').some((record) => record.rpc?.params['name'] === 'slow'));
    controller.abort(new Error('stop'));
    expect(await outcome).toBeInstanceOf(Error);
    await fixture.until(() => fixture.notes.some((note) => note.type === 'aborted'));
    expect(fixture.rpcRecords('notifications/cancelled')).toHaveLength(0);
  });
});

describe('streamable HTTP, protocol 2025-11-25', () => {
  it('falls back to initialize, keeps one session id and ends the session on close', async () => {
    const fixture = await startHttpFixture({ era: 'legacy' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    expect(connection.protocolEra).toBe('legacy');
    expect(connection.protocolVersion).toBe(HTTP_FIXTURE_LEGACY_VERSION);
    expect(textOf(await connection.callTool({ name: 'echo', arguments: { text: 'hi' }, signal: NEVER_ABORTED }))).toBe('hi');

    expect(fixture.rpcRecords('server/discover')[0]?.status).toBe(400);
    const sessionIds = new Set(
      fixture.records.filter((record) => record.rpc?.method !== 'initialize' && record.rpc?.method !== 'server/discover').map((record) => record.headers['mcp-session-id']),
    );
    expect(sessionIds.size).toBe(1);
    expect([...sessionIds][0]).toBeDefined();

    await connection.close();
    expect(fixture.notes.filter((note) => note.type === 'session_deleted')).toHaveLength(1);
  });

  it('stops waiting for a server that never answers the session DELETE and reports it', async () => {
    const fixture = await startHttpFixture({ era: 'legacy', holdSessionDelete: true });
    const timers = observedTimers(createFakeClock(1_000_000));
    const { connection } = makeRemoteConnection({ fixture, timers, closeInCleanup: false, connection: { closeGraceMs: 750 } });
    await connection.listTools();
    const armed = timers.nextScheduled((ms) => ms === 750);
    const closing = connection.close().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    await armed;
    timers.advance(750);
    expect((await closing)?.message).toContain('did not end its session within 750ms');
  });

  it('resumes a broken response stream with Last-Event-ID without re-issuing the call', async () => {
    const fixture = await startHttpFixture({ era: 'legacy' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    const result = await connection.callTool({ name: 'stream_drop', arguments: {}, signal: NEVER_ABORTED });
    expect(textOf(result)).toBe('resumed result');
    expect(fixture.rpcRecords('tools/call')).toHaveLength(1);
    const resume = fixture.records.find((record) => record.httpMethod === 'GET' && record.headers['last-event-id'] !== undefined);
    expect(resume?.headers['last-event-id']).toMatch(/^s\d+:1$/);
  });

  it('starts a new session when the server answers 404 for the old one and retries the unprocessed request once', async () => {
    const fixture = await startHttpFixture({ era: 'legacy' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    const before = fixture.rpcRecords('initialize').length;
    fixture.expireSessions();
    expect(textOf(await connection.callTool({ name: 'echo', arguments: { text: 'again' }, signal: NEVER_ABORTED }))).toBe('again');
    expect(fixture.rpcRecords('initialize')).toHaveLength(before + 1);
    expect(fixture.rpcRecords('tools/call').map((record) => record.status)).toEqual([404, 200]);
  });

  it('sends notifications/cancelled for an aborted call', async () => {
    const fixture = await startHttpFixture({ era: 'legacy' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    const controller = new AbortController();
    const outcome = connection.callTool({ name: 'slow', arguments: {}, signal: controller.signal }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await fixture.until(() => fixture.rpcRecords('tools/call').some((record) => record.rpc?.params['name'] === 'slow'));
    controller.abort(new Error('stop'));
    expect(await outcome).toBeInstanceOf(Error);
    await fixture.until(() => fixture.notes.some((note) => note.type === 'cancelled'));
  });
});
