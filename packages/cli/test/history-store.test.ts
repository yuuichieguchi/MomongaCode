import fs from 'node:fs';
import path from 'node:path';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { HISTORY_ENTRIES, HISTORY_FILE_MODE, PREVIOUS_HISTORY_SUFFIX, createHistoryStore } from '../src/history-store.ts';
import { nodeFiles } from '../src/node-ports.ts';

const lines = (count: number, from = 0): string => Array.from({ length: count }, (_, index) => `${JSON.stringify(`entry ${from + index}`)}\n`).join('');

describe('history store', () => {
  it('has no entries before the first submission', async (context) => {
    const store = createHistoryStore(nodeFiles, path.join(withTempDir(context), 'state', 'history.jsonl'));
    expect(await store.load()).toEqual([]);
  });

  it('keeps multi-line entries intact across loads and creates the file private', async (context) => {
    const file = path.join(withTempDir(context), 'state', 'history.jsonl');
    const store = createHistoryStore(nodeFiles, file);

    await store.append('first');
    await store.append('line one\nline two');

    expect(await createHistoryStore(nodeFiles, file).load()).toEqual(['first', 'line one\nline two']);
    expect(fs.statSync(file).mode & 0o777).toBe(HISTORY_FILE_MODE);
  });

  it('loads only the most recent entries and moves a full file aside instead of rewriting it', async (context) => {
    const file = path.join(withTempDir(context), 'history.jsonl');
    const total = HISTORY_ENTRIES + 5;
    fs.writeFileSync(file, lines(total));

    const loaded = await createHistoryStore(nodeFiles, file).load();

    expect(loaded).toHaveLength(HISTORY_ENTRIES);
    expect(loaded.at(-1)).toBe(`entry ${total - 1}`);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(`${file}${PREVIOUS_HISTORY_SUFFIX}`, 'utf8')).toBe(lines(total));
  });

  it('keeps an entry another session appended between the read of a full file and the move aside', async (context) => {
    const file = path.join(withTempDir(context), 'history.jsonl');
    fs.writeFileSync(file, lines(HISTORY_ENTRIES));
    const racing = {
      ...nodeFiles,
      rename: async (from: string, to: string) => {
        await nodeFiles.appendText(file, `${JSON.stringify('typed in the other terminal')}\n`, { directory: 0o700, file: HISTORY_FILE_MODE });
        await nodeFiles.rename(from, to);
      },
    };

    await createHistoryStore(racing, file).load();

    expect(await createHistoryStore(nodeFiles, file).load()).toContain('typed in the other terminal');
  });

  it('reads the entries before the move aside and after it, in order', async (context) => {
    const file = path.join(withTempDir(context), 'history.jsonl');
    fs.writeFileSync(file, lines(HISTORY_ENTRIES));
    const store = createHistoryStore(nodeFiles, file);
    await store.load();
    await store.append('after the move');

    const loaded = await createHistoryStore(nodeFiles, file).load();

    expect(loaded).toHaveLength(HISTORY_ENTRIES);
    expect(loaded.at(-1)).toBe('after the move');
    expect(loaded.at(-2)).toBe(`entry ${HISTORY_ENTRIES - 1}`);
  });

  it('reports a corrupt file instead of dropping its entries', async (context) => {
    const file = path.join(withTempDir(context), 'history.jsonl');
    fs.writeFileSync(file, '"fine"\nnot json\n');

    await expect(createHistoryStore(nodeFiles, file).load()).rejects.toThrow(`input history ${file} is corrupt at line 2`);
  });

  it('names the physical line of a corrupt entry even when blank lines precede it, and says how to recover', async (context) => {
    const file = path.join(withTempDir(context), 'history.jsonl');
    fs.writeFileSync(file, '"fine"\n\n\nnot json\n');

    const failure = await createHistoryStore(nodeFiles, file).load().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((failure as Error).message).toContain(`input history ${file} is corrupt at line 4`);
    expect((failure as Error).message).toContain('delete the file to start with an empty history');
  });

  it('rejects an entry that is not a string', async (context) => {
    const file = path.join(withTempDir(context), 'history.jsonl');
    fs.writeFileSync(file, '{"text":"x"}\n');

    await expect(createHistoryStore(nodeFiles, file).load()).rejects.toThrow('an entry is not a string');
  });
});
