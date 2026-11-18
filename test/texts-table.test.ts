import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { ROOT, childOf, identifierName, lineOf, parseSource, parsedProductSource, productSources, relativeOf, sourcesUnder, stringPartsOf } from './support/source-scan.ts';
import type { ParsedSource } from './support/source-scan.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const DESIGN_DOCUMENTS_VARIABLE = 'MOMONGA_DESIGN_DOCUMENTS';

const DESIGNS = process.env[DESIGN_DOCUMENTS_VARIABLE];

const TEXT_SECTIONS = [
  { design: 'models.md', heading: '## 13. Texts approved under cli-tui DECISION-5' },
  { design: 'cli-tui.md', heading: '## Texts approved under cli-tui DECISION-5' },
] as const;

const PERSON_TREES = ['packages/cli/src/tui', 'packages/cli/src/commands'];

const UNBUILT_MECHANISM = /\buntil (?:it|they|this|that) (?:exists?|is built|are built|lands?)\b|\bnot built yet\b|\bnot yet built\b/i;

const PLACEHOLDER = /<[^>]+>/g;

const CODE_NAME = /^(?:[a-z_$][\w$]*(?:[.-][\w$]+)*|[A-Z][A-Z0-9_]*|[A-Z][\w$]*\.[\w$]+|--?[\w-]+|\/[\w-]+)$/;

const SOURCE_FILE = /^packages\/.+\.tsx?(:\d+)?$/;

const HAS_WORD = /\p{L}/u;

type ListedText = { readonly design: string; readonly text: string; readonly files: readonly string[]; readonly others: readonly string[] };

const sectionOf = (design: string, heading: string): string => {
  const text = fs.readFileSync(path.join(DESIGNS ?? '', design), 'utf8');
  const start = text.indexOf(heading);
  if (start < 0) throw new Error(`${design} has no section "${heading}"`);
  const rest = text.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
};

const listedTextsOf = (design: string, section: string): ListedText[] =>
  section
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .flatMap((line) => {
      const quoted = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
      const files = quoted.filter((item) => SOURCE_FILE.test(item)).map((item) => item.replace(/:\d+$/, ''));
      const texts = quoted.filter((item) => !SOURCE_FILE.test(item) && !CODE_NAME.test(item) && HAS_WORD.test(item));
      return texts.map((text) => ({ design, text, files, others: texts.filter((other) => other !== text) }));
    });

const fragmentsOf = ({ text, others }: ListedText): string[] =>
  others
    .filter((other) => other.length < text.length && text.includes(other))
    .reduce((rest, other) => rest.split(other).join('<listed>'), text)
    .split(PLACEHOLDER)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment !== '');

const PRESENT_MISMATCHES: Readonly<Record<string, string>> = {};

const sourceTextOf = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');

const placesOf = (listed: ListedText): string[] => (listed.files.length > 0 ? [...listed.files] : productSources().map(relativeOf));

const missingOf = (listed: ListedText, read: (file: string) => string = sourceTextOf): string[] => {
  const places = placesOf(listed).filter((file) => fs.existsSync(path.join(ROOT, file)));
  return fragmentsOf(listed).filter((fragment) => !places.some((file) => read(file).includes(fragment)));
};

const listedTexts = (): ListedText[] => TEXT_SECTIONS.flatMap(({ design, heading }) => listedTextsOf(design, sectionOf(design, heading)));

const unbuiltMechanismTexts = (source: ParsedSource): string[] =>
  stringPartsOf(source)
    .filter(({ text }) => UNBUILT_MECHANISM.test(text))
    .map(({ node, text }) => `${relativeOf(source.file)}:${lineOf(source, node)}: ${text.trim()}`);

const unbuiltIn = (text: string): number => unbuiltMechanismTexts(parseSource(path.join(ROOT, 'sample.ts'), text)).length;

const otherNameFieldsOf = (source: ParsedSource): string[] =>
  source.nodes
    .filter(({ node, parent }) => node.type === 'Property' && parent?.type === 'ObjectExpression' && identifierName(childOf(node, 'key')) === 'aliases')
    .map(({ node }) => `${relativeOf(source.file)}:${lineOf(source, node)}`);

describe('every text the person reads that was approved without a design text is in the design text list and in the code verbatim (cli-tui C51, DECISION-5)', () => {
  it('reads a listed text from a bullet, with the files it names, and leaves out code names, settings keys, command names and literals with no word', () => {
    const [first, second, ...rest] = listedTextsOf('planted.md', '- The rows (`packages/cli/src/tui/models/texts.ts`, `HUB_ACTIONS`): `Add a model`, `Programs`, `models.roles`, `/model`, `--start`, data `{}`.');
    expect(rest).toEqual([]);
    expect(first).toEqual({ design: 'planted.md', text: 'Add a model', files: ['packages/cli/src/tui/models/texts.ts'], others: ['Programs'] });
    expect(second?.text).toBe('Programs');
  });

  it('finds a listed text with placeholders by its fixed parts, and a composed text by the listed text it is made of', () => {
    const files = ['packages/cli/src/tui/models/fields.ts'];
    const read = (): string => 'const label = `${row.label} in minutes:`; const reason = `the file is larger than ${limit} KiB`;';
    expect(missingOf({ design: 'planted.md', text: 'the file is larger than <n> KiB', files, others: [] }, read)).toEqual([]);
    expect(missingOf({ design: 'planted.md', text: 'Start wait in minutes:', files, others: ['Start wait'] }, read)).toEqual([]);
    expect(missingOf({ design: 'planted.md', text: 'Wait a minute', files, others: [] }, read)).toEqual(['Wait a minute']);
  });

  it.skipIf(DESIGNS === undefined)(`holds every listed text in the file its bullet names, or in the product when it names none (needs the design folder named by ${DESIGN_DOCUMENTS_VARIABLE}; the release gate sets it)`, () => {
    const texts = listedTexts();
    expect(texts.length).toBeGreaterThan(0);
    const missing = texts.flatMap((listed) => missingOf(listed).map((fragment) => `${listed.design}: ${listed.text} (missing: ${fragment})`));
    expect(missing.filter((line) => !(line in PRESENT_MISMATCHES))).toEqual([]);
    expect(Object.keys(PRESENT_MISMATCHES).filter((line) => !missing.includes(line))).toEqual([]);
  });

  it('finds a text that names a mechanism until it exists, in any quote and in a template part', () => {
    expect(unbuiltIn("const text = 'Billing is shown until it exists';")).toBe(1);
    expect(unbuiltIn('const text = `${name} is not built yet`;')).toBe(1);
    expect(unbuiltIn("const text = 'until the next start';")).toBe(0);
  });

  it('shows the person no text that names a mechanism until it exists, in the screens and the commands', () => {
    const found = PERSON_TREES.flatMap((tree) => sourcesUnder(path.join(ROOT, tree))).flatMap((file) => unbuiltMechanismTexts(parsedProductSource(file)));
    expect(found).toEqual([]);
  });

  it('names the other names of a command by one field, SlashCommand.otherNames, and no aliases field is left in the CLI (P-378)', () => {
    expect(sourceTextOf('packages/cli/src/tui/slash.ts')).toMatch(/\breadonly otherNames\?: readonly string\[\]/);
    const found = sourcesUnder(path.join(ROOT, 'packages/cli/src')).flatMap((file) => otherNameFieldsOf(parsedProductSource(file)));
    expect(found).toEqual([]);
  });
});
