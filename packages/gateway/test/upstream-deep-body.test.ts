import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { anthropicErrorDetail } from '../src/adapters/anthropic/errors.ts';
import { decodeUpstreamReply, upstreamErrorEventBody } from '../src/adapters/chat-completions/upstream-reply.ts';
import { createUpstreamClassifier } from '../src/adapters/shared/classify.ts';
import { httpErrorOf } from '../src/adapters/shared/http-error.ts';
import { HTTP_TRANSPORT_VOCABULARY } from '../src/adapters/shared/vocabulary.ts';

const NOW_MS = 1_000_000;

const deepText = (depth: number): string => `{"error":${'['.repeat(depth - 1)}${']'.repeat(depth - 1)}}`;

const DEEP = deepText(MAX_JSON_DEPTH + 1);

const INVALID = '{"error": not json';

async function* bytesOf(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

const errorFor = (status: number, text: string) =>
  httpErrorOf({ status, headers: { 'retry-after': '5' }, body: bytesOf(text) }, createFakeClock(NOW_MS), anthropicErrorDetail, HTTP_TRANSPORT_VOCABULARY);

const shapeOf = (error: Awaited<ReturnType<typeof errorFor>>) => {
  const classified = createUpstreamClassifier('anthropic')(error);
  return {
    kind: error.constructor.name,
    status: error.status,
    upstreamCode: error.upstreamCode,
    retryAfterMs: error.retryAfterMs,
    guardrail: error.guardrail,
    contextOverflow: error.contextOverflow,
    unsupported: error.unsupported,
    retryHint: error.retryHint,
    retryable: classified.retryable,
    type: classified.error.type,
    code: classified.error.code,
  };
};

describe('an upstream HTTP error whose body is too deep is unusable JSON, like invalid JSON', () => {
  it('builds the deep body past the bound', () => {
    expect(DEEP.startsWith(`{"error":${'['.repeat(MAX_JSON_DEPTH)}]`)).toBe(true);
  });

  it.each([429, 401, 413, 500, 503])('keeps status %i, its classification and Retry-After', async (status) => {
    const deep = await errorFor(status, DEEP);
    const invalid = await errorFor(status, INVALID);
    expect(shapeOf(deep)).toEqual(shapeOf(invalid));
    expect(deep.status).toBe(status);
    expect(deep.retryAfterMs).toBe(5000);
    expect(deep.upstreamMessage).toBe(DEEP);
  });
});

describe('a chat completions reply whose JSON is too deep is unusable JSON, like invalid JSON', () => {
  it.each([400, 429, 500])('keeps the error status %i with the raw text as its body', async (status) => {
    expect(await decodeUpstreamReply(status, DEEP)).toEqual({ kind: 'error', status, body: DEEP });
    expect(await decodeUpstreamReply(status, INVALID)).toEqual({ kind: 'error', status, body: INVALID });
  });

  it('reads a deep SSE error event as its raw text', () => {
    expect(upstreamErrorEventBody({ event: 'error', data: DEEP })).toEqual({ body: DEEP });
  });

  it('decodes a deep completion the way it decodes an invalid one', async () => {
    expect(await decodeUpstreamReply(200, DEEP)).toEqual(await decodeUpstreamReply(200, INVALID));
  });

  it('skips a deep stream chunk the way it skips an invalid one', async () => {
    const stream = (chunk: string): string => `data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: ${chunk}\n\ndata: [DONE]\n\n`;
    expect(await decodeUpstreamReply(200, stream(DEEP))).toEqual(await decodeUpstreamReply(200, stream(INVALID)));
  });
});

describe('gateway adapters parse upstream JSON through one module', () => {
  const ADAPTERS = path.resolve(import.meta.dirname, '../src/adapters');
  const ENTRY = 'shared/upstream-json.ts';
  const PARSE_CALL = /\b(?:JSON\.parse|parseOutsideJson)\(/;

  const sourcesUnder = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourcesUnder(full);
      return entry.name.endsWith('.ts') ? [path.relative(ADAPTERS, full)] : [];
    });

  it('has no adapter file other than the shared entry that parses JSON itself', () => {
    const parsing = sourcesUnder(ADAPTERS).filter((file) => file !== ENTRY && PARSE_CALL.test(fs.readFileSync(path.join(ADAPTERS, file), 'utf8')));
    expect(parsing).toEqual([]);
  });
});
