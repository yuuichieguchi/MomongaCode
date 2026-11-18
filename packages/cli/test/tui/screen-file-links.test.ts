import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostPaths, nodeFileSystem } from '@momonga/foundation';
import { createTempDir } from '@momonga/testkit';
import { rowsOfEntry as rowsOfEntryWith } from '../../src/tui/screen/entry-rows.ts';
import { watchFileLinks } from '../../src/tui/screen/file-link-watch.ts';
import { fileLinkCandidates, fileLinkOf, fileLinkRootsOf, fileNoLongerExists, openFileLink, resolveFileLinks } from '../../src/tui/screen/file-links.ts';
import type { FileLinkPorts, FileLinkRoots, FileLinks, OpenFileUrl } from '../../src/tui/screen/file-links.ts';
import { createRowCache } from '../../src/tui/screen/row-cache.ts';
import { piecesOf } from '../../src/tui/screen/row-text.tsx';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import type { Row } from '../../src/tui/screen/wrap.ts';
import type { Entry } from '../../src/tui/transcript.ts';
import { ROW_FACTS, ROW_RENDERERS, ROW_SCHEDULE } from './screen-fakes.ts';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const folder = (): string => {
  const dir = fs.realpathSync(createTempDir());
  made.push(dir);
  return dir;
};

const ports = (): FileLinkPorts => ({ paths: hostPaths(new AbortController().signal), files: nodeFileSystem });

const project = async (): Promise<{ cwd: string; outside: string; roots: FileLinkRoots }> => {
  const cwd = folder();
  const outside = folder();
  fs.writeFileSync(path.join(cwd, 'gomoku.html'), '<html></html>');
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'test_logic.js'), '');
  fs.writeFileSync(path.join(outside, 'secret.txt'), '');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(cwd, 'leaves.txt'));
  fs.symlinkSync(path.join(cwd, 'gomoku.html'), path.join(cwd, 'stays.html'));
  return { cwd, outside, roots: await fileLinkRootsOf({ cwd, home: outside, additionalDirectories: [] }, ports()) };
};

const urlOf = (file: string): string => pathToFileURL(file).href;

const rowsOf = (entry: Entry, width = 80): Row[] => rowsOfEntryWith(entry, width, ROW_FACTS);

const linksOf = (rows: readonly Row[]) => rows.flatMap((row) => [...(row.links ?? [])].sort(([a], [b]) => a - b).map(([start, end, url, kind]) => ({ text: row.text.slice(start, end), url, kind })));

describe('the one function that decides a file link', () => {
  it('links an existing file inside the roots to its real path, with or without a line and column', async () => {
    const { cwd, roots } = await project();
    const gomoku = urlOf(path.join(cwd, 'gomoku.html'));
    for (const written of ['gomoku.html', 'gomoku.html:12', 'gomoku.html:12:3', './gomoku.html', path.join(cwd, 'gomoku.html'), 'stays.html']) {
      expect(await fileLinkOf(written, roots, ports())).toEqual({ kind: 'file', url: new URL(gomoku) });
    }
    expect(await fileLinkOf('src/test_logic.js', roots, ports())).toEqual({ kind: 'file', url: new URL(urlOf(path.join(cwd, 'src', 'test_logic.js'))) });
  });

  it('expands ~ against the home folder and still requires the file to lie inside the roots', async () => {
    const cwd = folder();
    fs.writeFileSync(path.join(cwd, 'notes.md'), '');
    const roots = await fileLinkRootsOf({ cwd, home: cwd, additionalDirectories: [] }, ports());
    expect(await fileLinkOf('~/notes.md', roots, ports())).toEqual({ kind: 'file', url: new URL(urlOf(path.join(cwd, 'notes.md'))) });
  });

  it('makes no link of a missing file, a directory, a path outside the roots, a symlink that leaves them, or a name with control characters', async () => {
    const { outside, roots } = await project();
    expect(await fileLinkOf('missing.html', roots, ports())).toEqual({ kind: 'missing' });
    expect(await fileLinkOf('src', roots, ports())).toEqual({ kind: 'refused' });
    expect(await fileLinkOf(path.join(outside, 'secret.txt'), roots, ports())).toEqual({ kind: 'refused' });
    expect(await fileLinkOf('../secret.txt', roots, ports())).toEqual({ kind: 'missing' });
    expect(await fileLinkOf('leaves.txt', roots, ports())).toEqual({ kind: 'refused' });
    expect(await fileLinkOf('gomoku\u0007.html', roots, ports())).toEqual({ kind: 'refused' });
    expect(await fileLinkOf('gomoku.html‮', roots, ports())).toEqual({ kind: 'refused' });
  });

  it('a file inside an additional directory of the session is a link', async () => {
    const cwd = folder();
    const more = folder();
    fs.writeFileSync(path.join(more, 'shared.ts'), '');
    const roots = await fileLinkRootsOf({ cwd, home: cwd, additionalDirectories: [more] }, ports());
    expect(await fileLinkOf(path.join(more, 'shared.ts'), roots, ports())).toEqual({ kind: 'file', url: new URL(urlOf(path.join(more, 'shared.ts'))) });
  });

  it('percent-encodes the real path in the file URL with an empty host', async () => {
    const cwd = folder();
    fs.writeFileSync(path.join(cwd, 'my page#1.html'), '');
    const roots = await fileLinkRootsOf({ cwd, home: cwd, additionalDirectories: [] }, ports());
    const found = await resolveFileLinks(fileLinkCandidates('open `my page#1.html` now'), roots, ports());
    const url = found.get('my page#1.html');
    expect(url).toBe(urlOf(path.join(cwd, 'my page#1.html')));
    expect(url).toContain('my%20page%231.html');
    expect(new URL(url ?? '').host).toBe('');
  });

  it('takes the candidates from inline code and from whitespace tokens, without surrounding punctuation', () => {
    expect(fileLinkCandidates('I wrote `gomoku.html` and (src/test_logic.js:12), see **notes.md**.')).toEqual(['gomoku.html', 'I', 'wrote', 'and', 'src/test_logic.js:12', 'see', 'notes.md']);
  });
});

const assistant = (text: string, fileLinks?: FileLinks): Entry => ({ kind: 'assistant', itemId: 'a', text, open: false, ...(fileLinks === undefined ? {} : { fileLinks }) });

describe('file links in the rows', () => {
  const GOMOKU = 'file:///work/gomoku.html';
  const known: FileLinks = new Map([
    ['gomoku.html', GOMOKU],
    ['gomoku.html:12', GOMOKU],
  ]);

  it('an answer naming `gomoku.html` carries no link while the result is unknown and an OSC 8 file link once it is known', () => {
    expect(linksOf(rowsOf(assistant('Open `gomoku.html` in a browser.')))).toEqual([]);
    const rows = rowsOf(assistant('Open `gomoku.html` in a browser.', known));
    expect(rows.map((row) => row.text)).toEqual(['Open gomoku.html in a browser.']);
    expect(linksOf(rows)).toEqual([{ text: 'gomoku.html', url: GOMOKU, kind: 'file' }]);
    expect(piecesOf(rows[0] as Row, undefined).find((piece) => piece.text === 'gomoku.html')?.url).toBe(GOMOKU);
  });

  it('keeps the line suffix in the visible text while the URL names the file, for a plain token too', () => {
    const rows = rowsOf(assistant('See gomoku.html:12 for the board.', known));
    expect(rows.map((row) => row.text)).toEqual(['See gomoku.html:12 for the board.']);
    expect(linksOf(rows)).toEqual([{ text: 'gomoku.html:12', url: GOMOKU, kind: 'file' }]);
  });

  it('makes no file link inside a fenced code block', () => {
    expect(linksOf(rowsOf(assistant('```\ngomoku.html\n```', known)))).toEqual([]);
  });

  it('a file URL the model writes itself is never a link', () => {
    expect(linksOf(rowsOf(assistant('[x](file:///etc/passwd) <file:///etc/passwd> file:///etc/passwd', known)))).toEqual([]);
  });

  it('web links stay web links next to file links', () => {
    expect(linksOf(rowsOf(assistant('`gomoku.html` and https://example.test/page', known)))).toEqual([
      { text: 'gomoku.html', url: GOMOKU, kind: 'file' },
      { text: 'https://example.test/page', url: 'https://example.test/page', kind: 'web' },
    ]);
  });

  it('a tool line names its file as a link once it is known', () => {
    const tool: Entry = { kind: 'tool', callId: 'c', name: 'write', title: 'Write gomoku.html', toolKind: 'edit', rawInput: undefined, status: 'completed', calledAt: 0, shownAt: 0, fileLinks: known };
    expect(linksOf(rowsOf(tool).slice(0, 1))).toEqual([{ text: 'gomoku.html', url: GOMOKU, kind: 'file' }]);
  });

  it('the row cache draws the links again when they become known for an answer it already holds', () => {
    const store = createTranscriptStore();
    store.append(assistant('Open `gomoku.html`.'), 'a');
    const cache = createRowCache(ROW_RENDERERS, ROW_SCHEDULE);
    expect(linksOf(cache.rowsOf(store.at(0), 80))).toEqual([]);
    store.change('a', (entry) => ({ ...entry, fileLinks: known }));
    expect(linksOf(cache.rowsOf(store.at(0), 80))).toEqual([{ text: 'gomoku.html', url: GOMOKU, kind: 'file' }]);
  });
});

describe('resolving file links when an entry is complete', () => {
  const answerOf = (store: ReturnType<typeof createTranscriptStore>, index: number): Entry => store.at(index).entry;

  it('asks once the answer is complete, never while it streams, and keeps the result with the entry', async () => {
    const store = createTranscriptStore();
    const asked: (readonly string[])[] = [];
    const watching = new AbortController();
    watchFileLinks(store, async (candidates) => {
      asked.push(candidates);
      return new Map([['gomoku.html', 'file:///w/gomoku.html']]);
    }, watching.signal, (error) => {
      throw error;
    });
    store.append({ kind: 'assistant', itemId: 'a', text: 'Open', open: true }, 'a');
    store.change('a', (entry) => ({ ...entry, text: 'Open `gomoku.html`' }));
    expect(asked).toEqual([]);
    store.change('a', (entry) => ({ ...entry, open: false }));
    await vi.waitFor(() => expect(answerOf(store, 0)).toMatchObject({ fileLinks: new Map([['gomoku.html', 'file:///w/gomoku.html']]) }));
    expect(asked).toEqual([['gomoku.html', 'Open']]);
    watching.abort();
  });

  it('a file the turn creates after naming it becomes a link when the run ends', async () => {
    const store = createTranscriptStore();
    const existing = new Set<string>();
    watchFileLinks(store, async (candidates) => new Map(candidates.filter((name) => existing.has(name)).map((name) => [name, `file:///w/${name}`])), new AbortController().signal, (error) => {
      throw error;
    });
    store.update({ runStatus: 'RUNNING' });
    store.append(assistant('I will write `gomoku.html`.'), 'a');
    await vi.waitFor(() => expect(answerOf(store, 0)).toMatchObject({ fileLinks: new Map() }));
    existing.add('gomoku.html');
    store.update({ runStatus: 'COMPLETED' });
    await vi.waitFor(() => expect(answerOf(store, 0)).toMatchObject({ fileLinks: new Map([['gomoku.html', 'file:///w/gomoku.html']]) }));
  });

  it('a failed resolution is reported, not thrown', async () => {
    const store = createTranscriptStore();
    const failures: unknown[] = [];
    watchFileLinks(store, () => Promise.reject(new Error('the folder could not be read')), new AbortController().signal, (error) => failures.push(error));
    store.append(assistant('`gomoku.html`'), 'a');
    await vi.waitFor(() => expect(failures).toEqual([new Error('the folder could not be read')]));
  });
});

describe('opening a file link', () => {
  it('opens the real path through the open port as a file, and a deleted file gives one note', async () => {
    const { cwd, roots } = await project();
    const opened: { url: string; kind: 'file' }[] = [];
    const open: OpenFileUrl = (url, _watch, _onFailure, kind) => opened.push({ url: url.href, kind });
    const notes: string[] = [];
    const file = path.join(cwd, 'gomoku.html');
    openFileLink(new URL(urlOf(file)), async () => roots, ports(), open, new AbortController().signal, (message) => notes.push(message));
    await vi.waitFor(() => expect(opened).toEqual([{ url: urlOf(file), kind: 'file' }]));
    fs.rmSync(file);
    expect(() => openFileLink(new URL(urlOf(file)), async () => roots, ports(), open, new AbortController().signal, (message) => notes.push(message))).not.toThrow();
    await vi.waitFor(() => expect(notes).toEqual([fileNoLongerExists(file)]));
    expect(opened).toHaveLength(1);
  });

  it('refuses a URL that is not a local file', () => {
    const notes: string[] = [];
    openFileLink(new URL('https://example.test/x'), () => Promise.reject(new Error('not asked')), ports(), () => undefined, new AbortController().signal, (message) => notes.push(message));
    expect(notes).toEqual(['https://example.test/x is not a file link']);
  });
});
