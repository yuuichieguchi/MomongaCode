import { describe, expect, it } from 'vitest';
import { PATTERN_CHECK_LIMIT_MS } from '@momonga/foundation';
import { makeRemoteConnection, startHttpFixture, textOf } from './remote-harness.ts';

const HOSTILE = `${'a'.repeat(48)}b`;

const failureOf = (promise: Promise<unknown>): Promise<Error> =>
  promise.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error: unknown) => error as Error,
  );

const connected = async () => {
  const fixture = await startHttpFixture({ era: 'modern' });
  const { connection } = makeRemoteConnection({ fixture });
  await connection.listTools();
  return connection;
};

describe('structured output under a pattern the linear engine cannot read', () => {
  it('is accepted by the SDK and by the off-thread check when it matches', async () => {
    const connection = await connected();
    expect(textOf(await connection.callTool({ name: 'structured_pattern', arguments: { s: 'aaaa' } }))).toBe('structured_pattern');
  });

  it('is refused as not matching the output schema when the off-thread check says it does not match', async () => {
    const connection = await connected();
    const failure = await failureOf(connection.callTool({ name: 'structured_pattern', arguments: { s: 'aab' } }));
    expect(failure.message).toContain("Structured content does not match the tool's output schema");
  });

  it('is refused with the English refusal when the check passes the limit', async () => {
    const connection = await connected();
    const failure = await failureOf(connection.callTool({ name: 'structured_pattern', arguments: { s: HOSTILE }, timeoutMs: 60_000 }));
    expect(failure.message).toContain(
      `The output of structured_pattern could not be checked against its schema within ${PATTERN_CHECK_LIMIT_MS / 1000} seconds: the pattern of s is too costly to match.`,
    );
  }, 30_000);

  it('ends with the call when its signal stops the check', async () => {
    const connection = await connected();
    const controller = new AbortController();
    const pending = failureOf(connection.callTool({ name: 'structured_pattern', arguments: { s: HOSTILE }, signal: controller.signal, timeoutMs: 60_000 }));
    setTimeout(() => controller.abort(new Error('stopped by the caller')), 500);
    const started = Date.now();
    const failure = await pending;
    expect(failure.message).toContain('stopped by the caller');
    expect(Date.now() - started).toBeLessThan(PATTERN_CHECK_LIMIT_MS);
  }, 30_000);
});
