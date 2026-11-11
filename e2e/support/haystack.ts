import fs from 'node:fs';
import path from 'node:path';
import { displayToolPath, hostPaths, sha256Hex } from '@momonga/foundation';

export const HAYSTACK_FILE_NAME = 'haystack.txt';
export const HAYSTACK_TARGET_CHARS = 20_000;
export const HAYSTACK_LINE_COUNT = 100;
export const HAYSTACK_READ_BACK_LINE = 50;
export const NEEDLE = 'needle';

export type Haystack = {
  readonly file: string;
  readonly grepLines: readonly string[];
  readonly grepOutput: string;
  readonly handle: string;
};

export const grepPrefixOf = (file: string, lineNumber: number): string => `${file}:${lineNumber}:${NEEDLE}`;

export const grepLinesFor = (file: string): string[] => {
  const prefixes = Array.from({ length: HAYSTACK_LINE_COUNT }, (_, index) => grepPrefixOf(file, index + 1));
  const separators = HAYSTACK_LINE_COUNT - 1;
  const padding = Math.max(0, HAYSTACK_TARGET_CHARS - separators - prefixes.reduce((total, prefix) => total + prefix.length, 0));
  const share = Math.floor(padding / HAYSTACK_LINE_COUNT);
  const first = padding - share * (HAYSTACK_LINE_COUNT - 1);
  return prefixes.map((prefix, index) => `${prefix}${'x'.repeat(index === 0 ? first : share)}`);
};

export const fileLineOf = (grepLine: string, file: string, lineNumber: number): string => grepLine.slice(`${file}:${lineNumber}:`.length);

export const catLine = (lineNumber: number, text: string): string => `${String(lineNumber).padStart(6)}\t${text}`;

export const readBackOutputOf = (haystack: Haystack, lineNumber: number): string =>
  `${catLine(lineNumber, haystack.grepLines[lineNumber - 1] ?? '')}\n[Showed lines ${lineNumber}–${lineNumber}. Continue with offset=${lineNumber + 1}.]`;

export const writeHaystack = async (project: string): Promise<Haystack> => {
  const file = path.join(project, HAYSTACK_FILE_NAME);
  const shown = await displayToolPath(project, file, hostPaths(new AbortController().signal));
  const grepLines = grepLinesFor(shown);
  const grepOutput = grepLines.join('\n');
  fs.writeFileSync(file, `${grepLines.map((line, index) => fileLineOf(line, shown, index + 1)).join('\n')}\n`);
  return { file, grepLines, grepOutput, handle: sha256Hex(grepOutput) };
};

export const fillerFileName = (index: number, lineChars: number): string => `filler-${lineChars}-${index}.txt`;

export const fillerLinesOf = (index: number, lineChars: number): string[] =>
  [1, 2].map((line) => `f${index}l${line}-`.padEnd(lineChars, String.fromCharCode(97 + ((index + line) % 26))));

export const writeFiller = (project: string, index: number, lineChars: number): string => {
  const file = path.join(project, fillerFileName(index, lineChars));
  fs.writeFileSync(file, `${fillerLinesOf(index, lineChars).join('\n')}\n`);
  return file;
};
