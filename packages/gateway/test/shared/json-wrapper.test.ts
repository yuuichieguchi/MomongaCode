import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { detectLocalServers } from '../../src/index.ts';
import type { DetectFetch } from '../../src/index.ts';
import { invertReply } from '../../src/dialect/unwrap.ts';

const tooDeep = `${'['.repeat(MAX_JSON_DEPTH + 1)}${']'.repeat(MAX_JSON_DEPTH + 1)}`;
const tooDeepObject = `${'{"a":'.repeat(MAX_JSON_DEPTH + 1)}null${'}'.repeat(MAX_JSON_DEPTH + 1)}`;

const bodyOf = (text: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield new TextEncoder().encode(text);
  },
});

const DEEP_SERVER = 'http://127.0.0.1:1';
const LISTING_SERVER = 'http://127.0.0.1:2';

const answering: DetectFetch = async (url) => {
  if (url.startsWith(DEEP_SERVER)) return { ok: true, body: bodyOf(tooDeep) };
  if (url === `${LISTING_SERVER}/v1/models`) return { ok: true, body: bodyOf(JSON.stringify({ object: 'list', data: [{ id: 'served-model', object: 'model' }] })) };
  return { ok: false, body: bodyOf('') };
};

describe('one wrapper for JSON that comes from outside', () => {
  it('maps a syntax error and a depth past the bound to the one typed malformed_json error', async () => {
    const { MalformedJsonError, parseExternalJson } = await import('../../src/adapters/shared/json.ts');
    for (const text of [tooDeep, '{"a":']) {
      let thrown: unknown;
      try {
        parseExternalJson(text);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MalformedJsonError);
      expect((thrown as InstanceType<typeof MalformedJsonError>).code).toBe('malformed_json');
    }
    expect(parseExternalJson('{"a":[1]}')).toEqual({ a: [1] });
  });

  it('lists the other servers when one local server answers with a document past the depth bound', async () => {
    const found = await detectLocalServers({
      candidates: [DEEP_SERVER, LISTING_SERVER],
      typed: [],
      signal: new AbortController().signal,
      fetch: answering,
      servers: [],
      exec: async () => {
        throw new Error('no process runs in this test');
      },
      exists: async () => false,
    });
    expect(found.map((server) => ('address' in server ? server.address : server.id))).toEqual([`${LISTING_SERVER}/v1`]);
  });

  it('leaves a reply past the depth bound as it came when inverting the wrapped properties', () => {
    expect(invertReply({ tool: 'lookup', wrapped: [{ at: [], property: 'a' }] }, tooDeepObject)).toBe(tooDeepObject);
  });
});
