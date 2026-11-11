import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const AUTO_FIT = path.join(ROOT, 'packages', 'config', 'src', 'auto-fit.ts');
const VIEW = path.join(ROOT, 'packages', 'runtime', 'src', 'service', 'auto-classifier-view.ts');
const APP = path.join(ROOT, 'packages', 'runtime', 'src', 'service', 'app.ts');
const CLASSIFIER = path.join(ROOT, 'packages', 'runtime', 'src', 'worker', 'auto-classifier.ts');
const CHECK_HOST = path.join(ROOT, 'packages', 'cli', 'src', 'commands', 'auto-mode.ts');

const read = (file: string): string => fs.readFileSync(file, 'utf8');

const exportedNames = (file: string): string[] => {
  const text = read(file);
  const declared = [...text.matchAll(/^export\s+(?:async\s+)?(?:const|function|class)\s+([A-Za-z0-9_$]+)/gm)].map((match) => match[1] as string);
  const listed = [...text.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((match) =>
    (match[1] as string)
      .split(',')
      .map((entry) => entry.trim().split(/\s+as\s+/).at(-1) ?? '')
      .filter((name) => name !== '' && !name.startsWith('type ')),
  );
  return [...declared, ...listed];
};

type Import = { names: string[]; from: string };

const importsOf = (text: string): Import[] =>
  [...text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g)].map((match) => ({
    names: (match[1] as string)
      .split(',')
      .map((entry) => entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? '')
      .filter((name) => name !== ''),
    from: match[2] as string,
  }));

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.generated.ts') ? [full] : [];
  });

const packageSources = (): string[] =>
  fs
    .readdirSync(path.join(ROOT, 'packages'))
    .map((name) => path.join(ROOT, 'packages', name, 'src'))
    .filter((directory) => fs.existsSync(directory))
    .flatMap(sourceFiles);

const resolveRelative = (from: string, specifier: string): string | undefined => {
  if (!specifier.startsWith('.')) return undefined;
  const target = path.resolve(path.dirname(from), specifier);
  return fs.existsSync(target) ? target : undefined;
};

const reachable = (entry: string): string[] => {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const { from } of importsOf(read(file))) {
      const target = resolveRelative(file, from);
      if (target !== undefined && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...seen];
};

const functionBody = (text: string, name: string): string => {
  const start = text.indexOf(`const ${name} = `);
  if (start === -1) throw new Error(`${name} is not defined`);
  const end = text.indexOf('\n};\n', start);
  return text.slice(start, end === -1 ? undefined : end);
};

const configNamesUsed = (file: string, names: readonly string[]): string[] =>
  importsOf(read(file))
    .filter((entry) => entry.from === '@momonga/config' || entry.from.endsWith('auto-fit.ts'))
    .flatMap((entry) => entry.names)
    .filter((name) => names.includes(name));

describe('the measurement record never reaches availability or a verdict (I6.6)', () => {
  it('checkModeAllowed uses no export of config/src/auto-fit.ts and nothing of the view module', () => {
    const fit = exportedNames(AUTO_FIT);
    const view = exportedNames(VIEW);
    expect(fit.length).toBeGreaterThan(0);
    expect(view.length).toBeGreaterThan(0);
    const body = functionBody(read(APP), 'checkModeAllowed');
    const used = [...fit, ...view].filter((name) => new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(body));
    expect(used).toEqual([]);
    expect(body).not.toMatch(/\brecords?\b|\bmeasurement\b/);
  });

  it('the classifier module and every module it reaches import nothing of auto-fit and nothing of the view module', () => {
    const fit = exportedNames(AUTO_FIT);
    const files = reachable(CLASSIFIER);
    expect(files).not.toContain(VIEW);
    expect(files.flatMap((file) => configNamesUsed(file, fit).map((name) => `${path.relative(ROOT, file)}: ${name}`))).toEqual([]);
  });

  it('the view module is the only runtime module that reads a record', () => {
    const readers = exportedNames(AUTO_FIT).filter((name) => /^read\w*(Record|View)$/.test(name));
    expect(readers.length).toBeGreaterThan(0);
    const runtimeSources = sourceFiles(path.join(ROOT, 'packages', 'runtime', 'src'));
    expect(runtimeSources.filter((file) => configNamesUsed(file, readers).length > 0)).toEqual([VIEW]);
  });
});

describe('the record is written only by the client-side check host (I6.7)', () => {
  it('imports the auto-fit writer functions only from cli/src/commands/auto-mode.ts', () => {
    const writers = exportedNames(AUTO_FIT).filter((name) => /^write/.test(name));
    expect(writers.length).toBeGreaterThan(0);
    const importers = packageSources().filter((file) => file !== AUTO_FIT && configNamesUsed(file, writers).length > 0);
    expect(importers).toEqual([CHECK_HOST]);
  });

  it('keeps no auto gate module of the superseded design', () => {
    expect(fs.existsSync(path.join(ROOT, 'packages', 'config', 'src', 'auto-gate.ts'))).toBe(false);
  });
});

describe('both entries reach the one autoModeCheck of cli/src/commands/auto-mode.ts', () => {
  const cliSources = (): string[] => sourceFiles(path.join(ROOT, 'packages', 'cli', 'src'));

  const importsCheck = (file: string): boolean =>
    importsOf(read(file)).some((entry) => entry.names.includes('autoModeCheck') && resolveRelative(file, entry.from) === CHECK_HOST);

  it('defines autoModeCheck only in cli/src/commands/auto-mode.ts', () => {
    const definers = cliSources().filter((file) => /\b(?:const|function)\s+autoModeCheck\b/.test(read(file)));
    expect(definers).toEqual([CHECK_HOST]);
  });

  it('momonga auto-mode check in register.ts imports it from the check host', () => {
    expect(importsCheck(path.join(ROOT, 'packages', 'cli', 'src', 'commands', 'register.ts'))).toBe(true);
  });

  it('the builder of the TUI port context.autoMode.check imports it from the check host', () => {
    const builders = cliSources().filter((file) => file !== CHECK_HOST && /\bautoMode\s*[:=]/.test(read(file)) && /\bcheck\s*:/.test(read(file)));
    expect(builders.length).toBeGreaterThan(0);
    expect(builders.filter((file) => !importsCheck(file)).map((file) => path.relative(ROOT, file))).toEqual([]);
  });
});
