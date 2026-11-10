import path from 'node:path';
import type { RunClass } from './run-lock.ts';

export type { RunClass };

export const RUN_CLASS_KEY = 'momonga.runClass';

export type ProjectRunClass = 'heavy' | 'heavy-when-whole';

declare module 'vitest' {
  interface ProvidedContext {
    'momonga.runClass'?: ProjectRunClass;
  }
}

export type SelectionProject = { readonly name: string; readonly runClass: ProjectRunClass | undefined; readonly files: readonly string[] };

export type ClassRequest = {
  readonly selected: readonly string[];
  readonly projects: readonly SelectionProject[];
  readonly repoRoot: string;
  readonly tierRunner: string;
  readonly readFile: (file: string) => Promise<string>;
};

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const SOURCE_SPECIFIER = /\.tsx?$/;
const TEST_SIDE_ROOTS = ['test', 'scripts', 'e2e'];

const isTestSide = (repoRoot: string, file: string): boolean => {
  const [first, , third, ...deeper] = path.relative(repoRoot, file).split(path.sep);
  if (first === undefined || first === '..' || path.isAbsolute(first)) return false;
  if (TEST_SIDE_ROOTS.includes(first)) return true;
  return first === 'packages' && third === 'test' && deeper.length > 0;
};

const decidedByProjects = (selected: ReadonlySet<string>, projects: readonly SelectionProject[]): boolean =>
  projects.some(({ runClass, files }) => {
    if (runClass === 'heavy') return files.some((file) => selected.has(file));
    if (runClass === 'heavy-when-whole') return files.length > 0 && files.every((file) => selected.has(file));
    return false;
  });

const importedSources = async (file: string, readFile: ClassRequest['readFile']): Promise<string[]> => {
  let text: string;
  try {
    text = await readFile(file);
  } catch {
    return [];
  }
  return [...text.matchAll(RELATIVE_IMPORT)]
    .map(([, specifier = '']) => specifier)
    .filter((specifier) => SOURCE_SPECIFIER.test(specifier))
    .map((specifier) => path.resolve(path.dirname(file), specifier));
};

const reachesTierRunner = async ({ selected, repoRoot, tierRunner, readFile }: ClassRequest): Promise<boolean> => {
  const seen = new Set<string>(selected);
  let frontier: readonly string[] = [...seen];
  while (frontier.length > 0) {
    const imported = (await Promise.all(frontier.map((file) => importedSources(file, readFile)))).flat();
    if (imported.includes(tierRunner)) return true;
    const next = [...new Set(imported)].filter((file) => !seen.has(file) && isTestSide(repoRoot, file));
    for (const file of next) seen.add(file);
    frontier = next;
  }
  return false;
};

export const classOfSelection = async (request: ClassRequest): Promise<RunClass> => {
  if (decidedByProjects(new Set(request.selected), request.projects)) return 'heavy';
  return (await reachesTierRunner(request)) ? 'heavy' : 'light';
};
