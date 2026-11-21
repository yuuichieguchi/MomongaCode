import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../bundle.ts';
import { classOfSelection } from './run-class.ts';
import type { SelectionProject } from './run-class.ts';

const A = '/r/test/a.test.ts';
const B = '/r/test/b.test.ts';
const C = '/r/test/c.test.ts';
const X = '/r/e2e/x.test.ts';
const P = '/r/scripts/p.test.ts';
const SRC = '/r/packages/x/src/y.ts';
const EMPTY = 'export {};';

const PROJECTS: readonly SelectionProject[] = [
  { name: 'unit', runClass: 'heavy-when-whole', files: [A, B, C] },
  { name: 'e2e', runClass: 'heavy', files: [X] },
  { name: 'packaging', runClass: undefined, files: [P] },
];

type Row = {
  readonly title: string;
  readonly selected: readonly string[];
  readonly projects?: readonly SelectionProject[];
  readonly files?: Readonly<Record<string, string>>;
  readonly expected: 'heavy' | 'light';
  readonly readOnce?: readonly string[];
  readonly neverRead?: readonly string[];
};

const ROWS: readonly Row[] = [
  { title: 'every file of a project that is heavy when whole', selected: [A, B, C], expected: 'heavy' },
  { title: 'one file of that project', selected: [A], expected: 'light' },
  { title: 'every file of that project but one', selected: [A, B], expected: 'light' },
  { title: 'one file of a project that is heavy in every selection', selected: [X], expected: 'heavy' },
  { title: 'every file of a project with no class', selected: [P], expected: 'light' },
  {
    title: 'a file whose imports reach the tier runner through another file',
    selected: [A],
    files: { [A]: "import { h } from './h.ts';", '/r/test/h.ts': "import { describeTier } from './formal/tier.ts';" },
    expected: 'heavy',
  },
  { title: 'an import through a package specifier', selected: [A], files: { [A]: "import { x } from '@momonga/foundation';" }, expected: 'light' },
  {
    title: 'two files that import each other',
    selected: [A],
    files: { [A]: "import { b } from './b.ts';", '/r/test/b.ts': "import { a } from './a.test.ts';" },
    expected: 'light',
    readOnce: [A, '/r/test/b.ts'],
  },
  {
    title: 'an import of a product source file that imports the tier runner',
    selected: [A],
    files: { [A]: "import { y } from '../packages/x/src/y.ts';", [SRC]: "import { describeTier } from '../../../test/formal/tier.ts';" },
    expected: 'light',
    neverRead: [SRC],
  },
  { title: 'one file of the heavy-when-whole project plus one of the always-heavy project', selected: [A, X], expected: 'heavy' },
  { title: 'an empty selection with no projects', selected: [], projects: [], expected: 'light' },
  { title: 'an import of a file that does not exist', selected: [A], files: { [A]: "import { g } from './gone.ts';" }, expected: 'light' },
];

describe('classOfSelection', () => {
  it.each(ROWS)('TB1 $title is $expected', async ({ selected, projects = PROJECTS, files = {}, expected, readOnce = [], neverRead = [] }) => {
    const texts: Record<string, string> = { [A]: EMPTY, [B]: EMPTY, [C]: EMPTY, [X]: EMPTY, [P]: EMPTY, ...files };
    const calls: string[] = [];
    const readFile = (file: string): Promise<string> => {
      calls.push(file);
      const text = texts[file];
      return text === undefined ? Promise.reject(Object.assign(new Error(`no such file: ${file}`), { code: 'ENOENT' })) : Promise.resolve(text);
    };

    const runClass = await classOfSelection({ selected, projects, repoRoot: '/r', tierRunner: '/r/test/formal/tier.ts', readFile });

    expect(runClass).toBe(expected);
    for (const file of readOnce) expect(calls.filter((call) => call === file)).toEqual([file]);
    for (const file of neverRead) expect(calls).not.toContain(file);
  });
});

const root = path.resolve(repoRoot);

const sourceFiles = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === 'node_modules' || entry.name === 'dist') return [];
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return /\.(?:ts|tsx)$/.test(entry.name) ? [full] : [];
      })
    : [];

const packageTestDirs = (): string[] => fs.readdirSync(path.join(root, 'packages')).map((name) => path.join(root, 'packages', name, 'test'));

const testSideFiles = (): string[] => [path.join(root, 'test'), path.join(root, 'scripts'), path.join(root, 'e2e'), ...packageTestDirs()].flatMap(sourceFiles);

const projectTestFiles = (): string[] => [
  ...packageTestDirs().flatMap(sourceFiles).filter((file) => /\.test\.tsx?$/.test(file)),
  ...[path.join(root, 'test'), path.join(root, 'scripts'), path.join(root, 'e2e')].flatMap(sourceFiles).filter((file) => file.endsWith('.test.ts')),
];

const TLC_START_IMPORT = /import\s*(?:type\s*)?\{[^}]*\b(runTlc|checkEntry)\b[^}]*\}\s*from/;

describe('the files that can start the model-checking tier', () => {
  it('TB2 (a) only test/formal/tlc.test.ts reaches the tier runner through its imports', async () => {
    const texts = new Map<string, Promise<string>>();
    const readFile = (file: string): Promise<string> => {
      const known = texts.get(file);
      if (known !== undefined) return known;
      const text = fs.promises.readFile(file, 'utf8');
      texts.set(file, text);
      return text;
    };
    const reaching: string[] = [];
    for (const file of projectTestFiles()) {
      const runClass = await classOfSelection({ selected: [file], projects: [], repoRoot: root, tierRunner: path.join(root, 'test', 'formal', 'tier.ts'), readFile });
      if (runClass === 'heavy') reaching.push(path.relative(root, file));
    }

    expect(reaching).toEqual(['test/formal/tlc.test.ts']);
  });

  it('TB2 (b) only the known formal files import a function that starts TLC', () => {
    const known = ['test/formal/check-entry.ts', 'test/formal/check-entry.test.ts', 'test/formal/record-mode.test.ts', 'test/formal/tier.ts', 'test/formal/tlc.test.ts'];
    const importing = testSideFiles()
      .filter((file) => TLC_START_IMPORT.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file));

    expect(importing.filter((file) => !known.includes(file))).toEqual([]);
  });
});
