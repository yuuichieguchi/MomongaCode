import { EMPTY_KEY_DOCUMENT, KEY_FILE_MAX_BYTES, keyDocumentText, parseKeyFile, REASONS, resolveBindings } from './bindings.ts';
import type { BindingReport, KeyDocument } from './bindings.ts';
import { createKeyTable, KEYS } from './table.ts';
import type { KeyTable } from './table.ts';

export const KEY_FILE_MODE = 0o600;
export const KEY_FILE_STAT_MS = 1000;

export type KeyFileStat = { readonly mtimeMs: number; readonly size: number };

export type KeyFiles = {
  stat(file: string): Promise<KeyFileStat | undefined>;
  read(file: string): Promise<string>;
  write(file: string, text: string, mode: number): Promise<void>;
};

export type KeyEdit = (document: KeyDocument) => KeyDocument;

export type KeyBindings = {
  readonly shownFile: string;
  readonly file: string | undefined;
  table(): KeyTable;
  report(): BindingReport;
  subscribe(listener: () => void): () => void;
  listen(onNotice: (text: string) => void): () => void;
  load(): Promise<void>;
  poll(now: number): void;
  preview(edit: KeyEdit): BindingReport;
  change(edit: KeyEdit): Promise<BindingReport>;
};

export const ignoredNotice = (report: BindingReport, shownFile: string): string | undefined => {
  if (report.fileProblem !== undefined) return `${shownFile} was ignored (${report.fileProblem}); /keybindings shows why`;
  const count = report.entries.filter((entry) => entry.rejected !== undefined).length;
  if (count === 0) return undefined;
  return `${count} key ${count === 1 ? 'binding' : 'bindings'} in ${shownFile} ${count === 1 ? 'was' : 'were'} ignored; /keybindings shows why`;
};

export const KEY_FILE_UNAVAILABLE = 'the key-binding file is not available in this interface';

export const fixedKeyBindings = (table: KeyTable): KeyBindings => ({
  shownFile: '',
  file: undefined,
  table: () => table,
  report: () => ({ rows: table.rows(), entries: [] }),
  subscribe: () => () => undefined,
  listen: () => () => undefined,
  load: () => Promise.resolve(),
  poll: () => undefined,
  preview: () => ({ rows: table.rows(), entries: [] }),
  change: () => Promise.reject(new Error(KEY_FILE_UNAVAILABLE)),
});

export type KeyBindingsOptions = {
  file: string;
  shownFile: string;
  files: KeyFiles;
};

export const reloadFailed = (shownFile: string, error: unknown): string => `${shownFile} could not be read: ${error instanceof Error ? error.message : String(error)}`;

export const createKeyBindings = ({ file, shownFile, files }: KeyBindingsOptions): KeyBindings => {
  const listeners = new Set<() => void>();
  const noticeListeners = new Set<(text: string) => void>();
  const unheard: string[] = [];

  const onNotice = (text: string): void => {
    if (noticeListeners.size === 0) unheard.push(text);
    for (const listener of [...noticeListeners]) listener(text);
  };

  let document: KeyDocument = EMPTY_KEY_DOCUMENT;
  let report: BindingReport = { rows: KEYS, entries: [] };
  let table = createKeyTable(report.rows);
  let seen: KeyFileStat | undefined;
  let statAt: number | undefined;
  let reading = false;
  let polledWhileReading: number | undefined;

  const publish = (next: BindingReport): void => {
    report = next;
    table = createKeyTable(next.rows);
    for (const listener of [...listeners]) listener();
  };

  const refuse = (reason: string): void => publish({ rows: report.rows, entries: report.entries, fileProblem: reason });

  const read = async (found: KeyFileStat | undefined): Promise<string | undefined> => {
    seen = found;
    if (found === undefined) {
      document = EMPTY_KEY_DOCUMENT;
      publish(resolveBindings(document));
      return undefined;
    }
    if (found.size > KEY_FILE_MAX_BYTES) refuse(REASONS.tooLarge);
    else {
      const parsed = parseKeyFile(await files.read(file));
      if (parsed.kind === 'refused') refuse(parsed.reason);
      else {
        document = parsed.document;
        publish(resolveBindings(document));
      }
    }
    return ignoredNotice(report, shownFile);
  };

  const changed = (found: KeyFileStat | undefined): boolean => found?.mtimeMs !== seen?.mtimeMs || found?.size !== seen?.size;

  const readAndTell = async (found: KeyFileStat | undefined): Promise<void> => {
    const notice = await read(found);
    if (notice !== undefined) onNotice(notice);
  };

  const reload = async (): Promise<void> => {
    const found = await files.stat(file);
    if (changed(found)) await readAndTell(found);
  };

  function poll(now: number): void {
    if (reading) {
      polledWhileReading = now;
      return;
    }
    if (statAt !== undefined && now - statAt < KEY_FILE_STAT_MS) return;
    statAt = now;
    reading = true;
    reload()
      .catch((error: unknown) => onNotice(reloadFailed(shownFile, error)))
      .finally(() => {
        reading = false;
        const waiting = polledWhileReading;
        polledWhileReading = undefined;
        if (waiting !== undefined) poll(waiting);
      });
  }

  return {
    shownFile,
    file,
    table: () => table,
    report: () => report,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listen: (listener) => {
      noticeListeners.add(listener);
      for (const text of unheard.splice(0)) listener(text);
      return () => {
        noticeListeners.delete(listener);
      };
    },
    load: async () => readAndTell(await files.stat(file)),
    poll,
    preview: (edit) => resolveBindings(edit(document)),
    change: async (edit) => {
      if (report.fileProblem !== undefined) throw new Error(`${shownFile} cannot be changed here (${report.fileProblem}); correct or remove the file first`);
      const next = edit(document);
      await files.write(file, keyDocumentText(next), KEY_FILE_MODE);
      seen = await files.stat(file);
      document = next;
      publish(resolveBindings(next));
      return report;
    },
  };
};
