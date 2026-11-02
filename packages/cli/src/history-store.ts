import type { CliFiles } from './ports.ts';

export const HISTORY_ENTRIES = 500;

export const HISTORY_FILE_MODE = 0o600;

export const HISTORY_DIRECTORY_MODE = 0o700;

export const PREVIOUS_HISTORY_SUFFIX = '.1';

export type HistoryStore = {
  load(): Promise<readonly string[]>;
  append(text: string): Promise<void>;
};

export class HistoryCorrupt extends Error {
  constructor(file: string, line: number, detail: string) {
    super(`input history ${file} is corrupt at line ${line}: ${detail}`);
    this.name = 'HistoryCorrupt';
  }
}

const parseEntry = (file: string, line: string, number: number): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new HistoryCorrupt(file, number, error instanceof Error ? error.message : String(error));
  }
  if (typeof parsed !== 'string') throw new HistoryCorrupt(file, number, 'an entry is not a string');
  return parsed;
};

const readEntries = async (files: Pick<CliFiles, 'readTextIfPresent'>, file: string): Promise<string[]> => {
  const text = await files.readTextIfPresent(file);
  if (text === undefined) return [];
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line, index) => parseEntry(file, line, index + 1));
};

export const createHistoryStore = (files: Pick<CliFiles, 'readTextIfPresent' | 'appendText' | 'rename'>, file: string): HistoryStore => {
  const previous = `${file}${PREVIOUS_HISTORY_SUFFIX}`;

  const load = async (): Promise<readonly string[]> => {
    const older = await readEntries(files, previous);
    const current = await readEntries(files, file);
    if (current.length >= HISTORY_ENTRIES) await files.rename(file, previous);
    return [...older, ...current].slice(-HISTORY_ENTRIES);
  };

  const append = (text: string): Promise<void> =>
    files.appendText(file, `${JSON.stringify(text)}\n`, { directory: HISTORY_DIRECTORY_MODE, file: HISTORY_FILE_MODE });

  return { load, append };
};
