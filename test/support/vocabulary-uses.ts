import fs from 'node:fs';
import path from 'node:path';
import { bannedVariantsIn } from '../../packages/protocol/src/vocabulary.ts';
import { ROOT, lineOf, parsedProductSource, productSources, relativeOf, stringPartsOf } from './source-scan.ts';
import type { Counts, ParsedSource } from './source-scan.ts';

export type BannedUseSite = { readonly file: string; readonly line: number; readonly variant: string; readonly word: string; readonly text: string };

const PROSE = /[A-Za-z]\s+[A-Za-z]/;

export const isProse = (text: string): boolean => PROSE.test(text);

export const bannedUsesOfSource = (source: ParsedSource, file: string): BannedUseSite[] =>
  stringPartsOf(source).flatMap(({ node, text }) => {
    if (!isProse(text)) return [];
    return bannedVariantsIn(text).map((use) => ({ file, line: lineOf(source, node), variant: use.variant, word: use.word, text }));
  });

export const bannedUsesOfDocument = (file: string, text: string): BannedUseSite[] =>
  text.split('\n').flatMap((line, index) => bannedVariantsIn(line).map((use) => ({ file, line: index + 1, variant: use.variant, word: use.word, text: line })));

export const SCANNED_DOCUMENTS: readonly string[] = ['README.md'];

export const VOCABULARY_TABLE_FILE = 'packages/protocol/src/vocabulary.ts';

export const bannedUsesOfProduct = (): BannedUseSite[] => [
  ...productSources()
    .filter((file) => relativeOf(file) !== VOCABULARY_TABLE_FILE)
    .flatMap((file) => bannedUsesOfSource(parsedProductSource(file), relativeOf(file))),
  ...SCANNED_DOCUMENTS.flatMap((file) => bannedUsesOfDocument(file, fs.readFileSync(path.join(ROOT, file), 'utf8'))),
];

export const countedByFile = (sites: readonly BannedUseSite[]): Record<string, Counts> => {
  const counted: Record<string, Counts> = {};
  for (const site of sites) {
    const counts = (counted[site.file] ??= {});
    counts[site.variant] = (counts[site.variant] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.keys(counted)
      .sort()
      .map((file) => [file, Object.fromEntries(Object.entries(counted[file] ?? {}).sort(([left], [right]) => left.localeCompare(right)))]),
  );
};
