import { describe, expect, it } from 'vitest';
import { COPIED_SHOWN_MS, clipboardWriter, wireCopyButtons } from '../site/client/copy.ts';
import type { CopyClock, CopyTarget } from '../site/client/copy.ts';
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

const fakeTarget = (snippet: string): {
  target: CopyTarget;
  shown: () => boolean;
  done: () => boolean;
  status: () => string;
  click: () => void;
  listeners: () => number;
} => {
  let visible = false;
  let copied = false;
  let announced = '';
  const handlers: (() => void)[] = [];
  return {
    target: {
      show: () => {
        visible = true;
      },
      setDone: (value: boolean) => {
        copied = value;
      },
      setStatus: (value: string) => {
        announced = value;
      },
      onClick: (listener: () => void) => {
        handlers.push(listener);
      },
      code: () => snippet,
    },
    shown: () => visible,
    done: () => copied,
    status: () => announced,
    click: () => {
      for (const listener of handlers) listener();
    },
    listeners: () => handlers.length,
  };
};

const fakeClock = (): { clock: CopyClock; scheduled: { id: number; ms: number; callback: () => void }[]; cancelled: number[]; run: (id: number) => void } => {
  let nextId = 1;
  const scheduled: { id: number; ms: number; callback: () => void }[] = [];
  const cancelled: number[] = [];
  return {
    clock: {
      schedule: (callback, ms) => {
        const id = nextId++;
        scheduled.push({ id, ms, callback });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: (timer) => {
        cancelled.push(timer as unknown as number);
      },
    },
    scheduled,
    cancelled,
    run: (id) => {
      const entry = scheduled.find((each) => each.id === id);
      if (entry === undefined) throw new Error(`no timer ${id}`);
      entry.callback();
    },
  };
};

describe('clipboardWriter', () => {
  it('binds writeText when the clipboard exposes it and returns undefined otherwise', async () => {
    const written: string[] = [];
    const owner = {
      prefix: 'ok:',
      writeText(this: { prefix: string }, text: string): Promise<void> {
        written.push(`${this.prefix}${text}`);
        return Promise.resolve();
      },
    };
    const write = clipboardWriter(owner);
    expect(write).toBeDefined();
    await write?.('curl -fsSL https://momongacode.com/install.sh | bash');
    expect(written).toEqual(['ok:curl -fsSL https://momongacode.com/install.sh | bash']);
    expect(clipboardWriter(undefined)).toBeUndefined();
    expect(clipboardWriter(null)).toBeUndefined();
    expect(clipboardWriter({})).toBeUndefined();
    expect(clipboardWriter({ writeText: 'not a function' })).toBeUndefined();
  });
});

describe('wireCopyButtons', () => {
  it('shows each button, copies its code on click, switches to the copied state for COPIED_SHOWN_MS, and restores it', async () => {
    const first = fakeTarget('curl -fsSL https://momongacode.com/install.sh | bash');
    const second = fakeTarget('irm https://momongacode.com/install.ps1 | iex');
    const written: string[] = [];
    const errors: unknown[] = [];
    const timer = fakeClock();
    wireCopyButtons(
      [first.target, second.target],
      async (text) => {
        written.push(text);
      },
      'Copied',
      (error) => errors.push(error),
      timer.clock,
    );
    expect(first.shown()).toBe(true);
    expect(second.shown()).toBe(true);
    first.click();
    await Promise.resolve();
    expect(written).toEqual(['curl -fsSL https://momongacode.com/install.sh | bash']);
    expect(first.done()).toBe(true);
    expect(first.status()).toBe('Copied');
    expect(second.done()).toBe(false);
    expect(timer.scheduled.map(({ id, ms }) => ({ id, ms }))).toEqual([{ id: 1, ms: COPIED_SHOWN_MS }]);
    timer.run(1);
    expect(first.done()).toBe(false);
    expect(first.status()).toBe('');
    second.click();
    await Promise.resolve();
    expect(written).toEqual([
      'curl -fsSL https://momongacode.com/install.sh | bash',
      'irm https://momongacode.com/install.ps1 | iex',
    ]);
    expect(second.done()).toBe(true);
    expect(second.status()).toBe('Copied');
    expect(errors).toEqual([]);
  });

  it('replaces the restore timer when clicked again before COPIED_SHOWN_MS elapses', async () => {
    const entry = fakeTarget('momonga');
    const timer = fakeClock();
    wireCopyButtons([entry.target], async () => {}, 'Copied', () => {}, timer.clock);
    entry.click();
    await Promise.resolve();
    entry.click();
    await Promise.resolve();
    expect(timer.cancelled).toEqual([1]);
    expect(timer.scheduled.map(({ id, ms }) => ({ id, ms }))).toEqual([
      { id: 1, ms: COPIED_SHOWN_MS },
      { id: 2, ms: COPIED_SHOWN_MS },
    ]);
    expect(entry.done()).toBe(true);
    timer.run(2);
    expect(entry.done()).toBe(false);
    expect(entry.status()).toBe('');
  });

  it('leaves the button idle and reports the error when writing to the clipboard rejects or throws', async () => {
    const rejected = new DOMException('denied', 'NotAllowedError');
    const thrown = new TypeError('clipboard unavailable');
    const first = fakeTarget('a');
    const second = fakeTarget('b');
    const errors: unknown[] = [];
    const timer = fakeClock();
    wireCopyButtons([first.target], () => Promise.reject(rejected), 'Copied', (error) => errors.push(error), timer.clock);
    wireCopyButtons(
      [second.target],
      () => {
        throw thrown;
      },
      'Copied',
      (error) => errors.push(error),
      timer.clock,
    );
    first.click();
    second.click();
    await Promise.resolve();
    expect(first.done()).toBe(false);
    expect(first.status()).toBe('');
    expect(second.done()).toBe(false);
    expect(second.status()).toBe('');
    expect(timer.scheduled).toEqual([]);
    expect(errors).toEqual([thrown, rejected]);
  });

  it('keeps copy buttons hidden and wires no listener when clipboard writing is unavailable', () => {
    const entry = fakeTarget('momonga');
    wireCopyButtons([entry.target], undefined, 'Copied', () => {});
    expect(entry.shown()).toBe(false);
    expect(entry.listeners()).toBe(0);
  });
});
