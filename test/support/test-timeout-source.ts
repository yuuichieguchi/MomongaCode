import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');

const testFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return entry.name.endsWith('.test.ts') ? [full] : [];
  });

export const repositoryTests = (): Array<{ file: string; source: string }> =>
  [
    ...fs
      .readdirSync(path.join(ROOT, 'packages'))
      .map((name) => path.join(ROOT, 'packages', name, 'test'))
      .filter((dir) => fs.existsSync(dir))
      .flatMap(testFiles),
    ...testFiles(path.join(ROOT, 'test')),
  ].map((file) => ({ file: path.relative(ROOT, file), source: fs.readFileSync(file, 'utf8') }));

const skipQuoted = (source: string, start: number): number => {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length && source[index] !== quote) {
    if (source[index] === '\\') index += 1;
    else if (quote === '`' && source[index] === '$' && source[index + 1] === '{') index = closingOf(source, index + 1);
    index += 1;
  }
  return index;
};

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

const closingOf = (source: string, open: number): number => {
  const stack: string[] = [];
  for (let index = open; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (char === '"' || char === "'" || char === '`') index = skipQuoted(source, index);
    else if (char === '/' && source[index + 1] === '/') index = source.indexOf('\n', index) === -1 ? source.length : source.indexOf('\n', index);
    else if (char === '/' && source[index + 1] === '*') index = source.indexOf('*/', index) + 1;
    else if (OPENERS[char] !== undefined) stack.push(OPENERS[char] ?? '');
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return source.length;
};

const topLevelArguments = (source: string, open: number): string[] => {
  const close = closingOf(source, open);
  const args: string[] = [];
  let start = open + 1;
  for (let index = open + 1; index < close; index += 1) {
    const char = source[index] ?? '';
    if (char === '"' || char === "'" || char === '`') index = skipQuoted(source, index);
    else if (OPENERS[char] !== undefined) index = closingOf(source, index);
    else if (char === ',') {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = source.slice(start, close).trim();
  if (last !== '') args.push(last);
  return args;
};

const TEST_CALL = /(?<![\w.$])(?:it|test|describe|bench)((?:\.(?:only|skip|todo|concurrent|sequential|fails|runIf|skipIf|each|for))*)\s*\(/g;
const FUNCTION_ARGUMENT = /^(?:async\b|function\b|\(|[\w$]+\s*=>)/;

export const perTestTimeouts = (source: string): string[] => {
  const found: string[] = [];
  for (let match = TEST_CALL.exec(source); match !== null; match = TEST_CALL.exec(source)) {
    let open = match.index + match[0].length - 1;
    const modifiers = match[1] ?? '';
    if (/\.(?:each|for|runIf|skipIf)/.test(modifiers)) {
      const afterTable = closingOf(source, open) + 1;
      const next = source.slice(afterTable).match(/^\s*\(/);
      if (next === null) continue;
      open = afterTable + next[0].length - 1;
    }
    const args = topLevelArguments(source, open);
    const body = args.findIndex((arg, index) => index > 0 && FUNCTION_ARGUMENT.test(arg));
    const options = args.filter((arg, index) => index > 0 && index !== body && arg.startsWith('{') && /[tT]imeout\s*:/.test(arg));
    const trailing = body === -1 ? [] : args.slice(body + 1);
    for (const arg of [...options, ...trailing]) found.push(`${match[0].trim()} ${arg.replace(/\s+/g, ' ').slice(0, 60)}`);
  }
  return found;
};

export const timeoutKeys = (source: string): string[] => source.match(/\b(?:test|hook)Timeout\s*:\s*[^,}\n]*/g) ?? [];

export const fileLevelTestTimeout = (source: string, constant: string): boolean =>
  new RegExp(`^vi\\.setConfig\\(\\{\\s*testTimeout:\\s*${constant}\\s*\\}\\);?\\s*$`, 'm').test(source);

export const importsFromTestkit = (source: string, name: string): boolean =>
  new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'@momonga/testkit'`).test(source);

export const timeoutFormOffences = (source: string, constant: string): string[] => {
  const fileLevel = new RegExp(`^testTimeout\\s*:\\s*${constant}$`);
  return [
    ...timeoutKeys(source).filter((key) => !fileLevel.test(key.trim())).map((key) => `declares a timeout option: ${key.trim()}`),
    ...perTestTimeouts(source).map((timeout) => `passes a per-test timeout: ${timeout}`),
  ];
};
