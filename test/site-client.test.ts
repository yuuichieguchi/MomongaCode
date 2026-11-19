import { describe, expect, it } from 'vitest';
import { indexLoader } from '../site/client/index-loader.ts';
import type { FetchIndex } from '../site/client/index-loader.ts';
import type { SearchRecord } from '../site/client/search.ts';
import { readStored, writeStored } from '../site/client/storage.ts';
import type { KeyValueStore } from '../site/client/storage.ts';
import { wireAll } from '../site/client/wiring.ts';

const refusal = (name: string): DOMException => new DOMException('the browser refuses storage', name);

const storeThat = (fail: { get?: unknown; set?: unknown }): KeyValueStore => ({
  getItem: () => {
    if (fail.get !== undefined) throw fail.get;
    return 'dark';
  },
  setItem: () => {
    if (fail.set !== undefined) throw fail.set;
  },
});

describe('readStored and writeStored', () => {
  it('reads and writes the stored value when the browser allows storage', () => {
    const saved = new Map<string, string>();
    const store: KeyValueStore = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
    writeStored(() => store, 'theme', 'light');
    expect(readStored(() => store, 'theme')).toBe('light');
  });

  it.each(['SecurityError', 'QuotaExceededError'])('treats a %s on reaching the storage as no stored choice and stores nothing', (name) => {
    const unreachable = (): KeyValueStore => {
      throw refusal(name);
    };
    expect(readStored(unreachable, 'theme')).toBeNull();
    expect(() => writeStored(unreachable, 'theme', 'dark')).not.toThrow();
  });

  it.each(['SecurityError', 'QuotaExceededError'])('treats a %s from reading or writing as no stored choice and stores nothing', (name) => {
    expect(readStored(() => storeThat({ get: refusal(name) }), 'theme')).toBeNull();
    expect(() => writeStored(() => storeThat({ set: refusal(name) }), 'theme', 'dark')).not.toThrow();
  });

  it('lets any other error through', () => {
    const other = refusal('NotFoundError');
    const broken = new TypeError('not storage');
    expect(() => readStored(() => storeThat({ get: other }), 'theme')).toThrow(other);
    expect(() => writeStored(() => storeThat({ set: other }), 'theme', 'dark')).toThrow(other);
    expect(() => readStored(() => storeThat({ get: broken }), 'theme')).toThrow(broken);
    expect(() => writeStored(() => storeThat({ set: broken }), 'theme', 'dark')).toThrow(broken);
  });
});

const RECORDS: SearchRecord[] = [{ url: '/docs/features#sandbox', title: 'Sandbox', text: 'Bash runs under Seatbelt.' }];

const answering = (body: unknown) => ({ ok: true, status: 200, json: async (): Promise<unknown> => body });

describe('indexLoader', () => {
  it('tries a failed load again at the next call, and the failure still reaches the caller', async () => {
    const offline = new TypeError('Failed to fetch');
    const asked: string[] = [];
    const answers = [Promise.reject(offline), Promise.resolve(answering(RECORDS))];
    const fetchIndex: FetchIndex = (url) => {
      asked.push(url);
      const next = answers.shift();
      if (next === undefined) throw new Error('fetched more than twice');
      return next;
    };
    const load = indexLoader(fetchIndex, '/assets/search-index.json');
    await expect(load()).rejects.toBe(offline);
    await expect(load()).resolves.toEqual(RECORDS);
    expect(asked).toEqual(['/assets/search-index.json', '/assets/search-index.json']);
  });

  it('fetches a loaded index once', async () => {
    let fetched = 0;
    const load = indexLoader(async () => {
      fetched += 1;
      return answering(RECORDS);
    }, '/assets/search-index.json');
    await load();
    await expect(load()).resolves.toEqual(RECORDS);
    expect(fetched).toBe(1);
  });

  it('refuses an index that answers an error status or is not a list of records, and tries again', async () => {
    const answers = [{ ok: false, status: 503, json: async (): Promise<unknown> => [] }, answering([{ url: '/' }]), answering(RECORDS)];
    const load = indexLoader(async () => {
      const next = answers.shift();
      if (next === undefined) throw new Error('fetched more than three times');
      return next;
    }, '/i.json');
    await expect(load()).rejects.toThrow('the search index /i.json answered 503');
    await expect(load()).rejects.toThrow('the search index /i.json is not a list of records');
    await expect(load()).resolves.toEqual(RECORDS);
  });
});

describe('wireAll', () => {
  it('commits every part and then marks the page only when every part was prepared', () => {
    const done: string[] = [];
    wireAll(
      [
        () => () => done.push('first'),
        () => () => done.push('second'),
      ],
      () => done.push('marked'),
    );
    expect(done).toEqual(['first', 'second', 'marked']);
  });

  it('changes nothing and leaves the page unmarked when a part cannot be prepared', () => {
    const done: string[] = [];
    const missing = new Error('the page has no input');
    expect(() =>
      wireAll(
        [
          () => () => done.push('first'),
          () => () => done.push('second'),
          () => {
            throw missing;
          },
        ],
        () => done.push('marked'),
      ),
    ).toThrow(missing);
    expect(done).toEqual([]);
  });
});
