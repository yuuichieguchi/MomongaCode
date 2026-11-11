import fs from 'node:fs';
import path from 'node:path';
import { VOCABULARY } from '@momonga/protocol';
import type { VocabularyRow } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { ROOT, parseSource, productSources, relativeOf } from '../../../test/support/source-scan.ts';
import type { Counts } from '../../../test/support/source-scan.ts';
import { SCANNED_DOCUMENTS, VOCABULARY_TABLE_FILE, bannedUsesOfDocument, bannedUsesOfProduct, bannedUsesOfSource, countedByFile } from '../../../test/support/vocabulary-uses.ts';
import type { BannedUseSite } from '../../../test/support/vocabulary-uses.ts';

const LEDGER = path.join(ROOT, 'specs/vocabulary/ledger.json');

type Ledger = { readonly otherMeaning: Record<string, Counts>; readonly burnDown: Record<string, Counts> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const tableOf = (value: unknown, name: string): Record<string, Counts> => {
  if (!isRecord(value)) throw new Error(`${LEDGER}: ${name} is not an object`);
  return Object.fromEntries(
    Object.entries(value).map(([file, counts]) => {
      if (!isRecord(counts)) throw new Error(`${LEDGER}: ${name}.${file} is not an object`);
      return [
        file,
        Object.fromEntries(
          Object.entries(counts).map(([variant, count]) => {
            if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) throw new Error(`${LEDGER}: ${name}.${file}.${variant} is not a positive integer`);
            return [variant, count];
          }),
        ),
      ];
    }),
  );
};

const readLedger = (): Ledger => {
  const parsed: unknown = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  if (!isRecord(parsed) || !isRecord(parsed['uses'])) throw new Error(`${LEDGER} holds no uses`);
  return { otherMeaning: tableOf(parsed['uses']['otherMeaning'], 'uses.otherMeaning'), burnDown: tableOf(parsed['uses']['burnDown'], 'uses.burnDown') };
};

const rows: readonly VocabularyRow[] = Object.values(VOCABULARY);
const VARIANTS_WITH_ANOTHER_MEANING = new Set(rows.flatMap((row) => row.banned.filter((banned) => banned.keptFor !== undefined).map((banned) => banned.variant)));

const sample = (file: string, text: string): string[] => bannedUsesOfSource(parseSource(file, text), file).map((site) => `${site.line} ${site.variant}`);

const allowedOf = (ledger: Ledger, file: string, variant: string): number => (ledger.otherMeaning[file]?.[variant] ?? 0) + (ledger.burnDown[file]?.[variant] ?? 0);

const siteLine = (site: BannedUseSite): string => `${site.file}:${site.line} "${site.variant}" where the vocabulary says "${site.word}": ${site.text.trim()}`;

describe('the banned variants of the vocabulary table in the texts of the product', () => {
  it('reads a string, each piece of a template and the text of an element, and only where it is prose', () => {
    expect(sample('sample.ts', "export const a = 'No conversation has the id';\nexport const b = `That conversation ${a} of the target`;\n")).toEqual(['1 conversation', '2 conversation', '2 target']);
    expect(sample('sample.tsx', 'export const A = () => <b>Resume a conversation</b>;\n')).toEqual(['1 conversation']);
    expect(sample('sample.ts', "export const code = 'target_not_ready';\nexport const key = 'target';\nexport type T = 'the target type';\nexport const conversation = 1;\n")).toEqual([]);
  });

  it('reads a document line by line', () => {
    expect(bannedUsesOfDocument('README.md', '# MomongaCode\n\nMomonga Code is a coding agent.\n').map((site) => `${site.line} ${site.variant}`)).toEqual(['3 Momonga Code']);
  });

  it('scans the command definitions, the settings schema and the guide', () => {
    const scanned = new Set([...productSources().map(relativeOf), ...SCANNED_DOCUMENTS]);
    expect(['packages/cli/src/commands/register.ts', 'packages/cli/src/program.ts', 'packages/config/src/settings-schema.ts', 'README.md'].filter((file) => !scanned.has(file))).toEqual([]);
    expect(bannedUsesOfProduct().filter((site) => site.file === VOCABULARY_TABLE_FILE)).toEqual([]);
  });

  it('holds no banned variant beyond the ledger: a use is in the other meaning the table states for its word, or waits for the package of its area', () => {
    const ledger = readLedger();
    const sites = bannedUsesOfProduct();
    const found = countedByFile(sites);
    const over = sites.filter((site) => (found[site.file]?.[site.variant] ?? 0) > allowedOf(ledger, site.file, site.variant));
    expect(over.map(siteLine)).toEqual([]);
  });

  it('keeps no ledger line for a use that is gone, so that the ledger only shrinks', () => {
    const ledger = readLedger();
    const found = countedByFile(bannedUsesOfProduct());
    const files = [...new Set([...Object.keys(ledger.otherMeaning), ...Object.keys(ledger.burnDown)])].sort();
    const stale = files.flatMap((file) => {
      const variants = [...new Set([...Object.keys(ledger.otherMeaning[file] ?? {}), ...Object.keys(ledger.burnDown[file] ?? {})])].sort();
      return variants.filter((variant) => allowedOf(ledger, file, variant) > (found[file]?.[variant] ?? 0)).map((variant) => `${file} ${variant}: the ledger allows ${allowedOf(ledger, file, variant)}, the file holds ${found[file]?.[variant] ?? 0}`);
    });
    expect(stale).toEqual([]);
  });

  it('records another meaning only for a word the table gives one, and keeps both lists sorted by file', () => {
    const ledger = readLedger();
    const unfounded = Object.entries(ledger.otherMeaning).flatMap(([file, counts]) => Object.keys(counts).filter((variant) => !VARIANTS_WITH_ANOTHER_MEANING.has(variant)).map((variant) => `${file} ${variant}`));
    expect(unfounded).toEqual([]);
    expect(Object.keys(ledger.otherMeaning)).toEqual(Object.keys(ledger.otherMeaning).sort());
    expect(Object.keys(ledger.burnDown)).toEqual(Object.keys(ledger.burnDown).sort());
  });
});
