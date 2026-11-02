import fs from 'node:fs';
import path from 'node:path';

const BASH_DEFAULT_HISTSIZE = 500;

export const HISTORY_ENTRIES = BASH_DEFAULT_HISTSIZE;

export const HISTORY_FILE_MODE = 0o600;

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

const readLines = async (file: string): Promise<string[]> => {
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').filter((line) => line !== '');
};

export const createHistoryStore = (file: string): HistoryStore => {
  const load = async (): Promise<readonly string[]> => {
    const lines = await readLines(file);
    const entries = lines.map((line, index) => parseEntry(file, line, index + 1));
    if (entries.length <= 2 * HISTORY_ENTRIES) return entries.slice(-HISTORY_ENTRIES);
    const kept = entries.slice(-HISTORY_ENTRIES);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { mode: HISTORY_FILE_MODE });
    await fs.promises.rename(temporary, file);
    return kept;
  };

  const append = async (text: string): Promise<void> => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.promises.appendFile(file, `${JSON.stringify(text)}\n`, { mode: HISTORY_FILE_MODE });
  };

  return { load, append };
};
