import fs from 'node:fs';
import path from 'node:path';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { HISTORY_ENTRIES, HISTORY_FILE_MODE, createHistoryStore } from '../src/history-store.ts';

describe('history store', () => {
  it('has no entries before the first submission', async (context) => {
    const store = createHistoryStore(path.join(withTempDir(context), 'state', 'history.jsonl'));
    expect(await store.load()).toEqual([]);
  });

  it('keeps multi-line entries intact across loads and creates the file private', async (context) => {
    const file = path.join(withTempDir(context), 'state', 'history.jsonl');
    const store = createHistoryStore(file);

    await store.append('first');
    await store.append('line one\nline two');

    expect(await createHistoryStore(file).load()).toEqual(['first', 'line one\nline two']);
    expect(fs.statSync(file).mode & 0o777).toBe(HISTORY_FILE_MODE);
  });

  it('loads only the most recent entries and rewrites an oversized file down to them', async (context) => {
    const file = path.join(withTempDir(context), 'history.jsonl');
    const total = 2 * HISTORY_ENTRIES + 5;
    fs.writeFileSync(file, Array.from({ length: total }, (_, index) => `${JSON.stringify(`entry ${index}`)}\n`).join(''));

    const loaded = await createHistoryStore(file).load();

    expect(loaded).toHaveLength(HISTORY_ENTRIES);
    expect(loaded.at(-1)).toBe(`entry ${total - 1}`);
    expect(fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')).toHaveLength(HISTORY_ENTRIES);
  });

  it('reports a corrupt file instead of dropping its entries', async (context) => {
    const file = path.join(withTempDir(context), 'history.jsonl');
    fs.writeFileSync(file, '"fine"\nnot json\n');

    await expect(createHistoryStore(file).load()).rejects.toThrow(`input history ${file} is corrupt at line 2`);
  });

  it('rejects an entry that is not a string', async (context) => {
    const file = path.join(withTempDir(context), 'history.jsonl');
    fs.writeFileSync(file, '{"text":"x"}\n');

    await expect(createHistoryStore(file).load()).rejects.toThrow('an entry is not a string');
  });
});
