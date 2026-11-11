import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', 'dist', 'src', '.git', '.claude']);

const testSourcesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : testSourcesUnder(target);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [target] : [];
  });

const testSources = (): string[] => ['packages', 'test', 'e2e', 'scripts'].flatMap((name) => testSourcesUnder(path.join(ROOT, name)));

const closingParenthesis = (text: string, open: number): number => {
  let depth = 0;
  let quote = '';
  for (let index = open; index < text.length; index += 1) {
    const character = text[index] as string;
    if (quote !== '') {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const OBSERVED_DIRECTLY = /(?:\bawait|\breturn|\bvoid|=>)\s*$/;
const AWAITED_ALL = /(?:\bawait|\breturn)\s+Promise\.all\(\s*$/;

const enclosingOpener = (text: string, index: number): number => {
  let depth = 0;
  for (let position = index - 1; position >= 0; position -= 1) {
    const character = text[position] as string;
    if (character === ')' || character === ']' || character === '}') depth += 1;
    else if (character === '(' || character === '[' || character === '{') {
      if (depth === 0) return position;
      depth -= 1;
    }
  }
  return -1;
};

const insideAwaitedAll = (text: string, index: number): boolean => {
  const opener = enclosingOpener(text, index);
  return opener !== -1 && text[opener] === '[' && AWAITED_ALL.test(text.slice(Math.max(0, opener - 200), opener));
};

const START_CALL = /(?<![.\w$])start(?:RuntimeProcess|Supervisor|GatewayProcess)\(/g;
const OWNER_CALL = /\bregisterOwned\(/g;

const insideStringOnItsLine = (text: string, index: number): boolean => {
  const line = text.slice(text.lastIndexOf('\n', index - 1) + 1, index);
  return ["'", '"', '`'].some((quote) => line.split(quote).length % 2 === 0);
};

const ownedRanges = (text: string): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(OWNER_CALL)) {
    const open = match.index + match[0].length - 1;
    const close = closingParenthesis(text, open);
    if (close !== -1) ranges.push([open, close]);
  }
  return ranges;
};

const unownedStarts = (text: string): number[] => {
  const owned = ownedRanges(text);
  return [...text.matchAll(START_CALL)]
    .filter((match) => !insideStringOnItsLine(text, match.index))
    .filter((match) => !owned.some(([open, close]) => match.index > open && match.index < close))
    .map((match) => text.slice(0, match.index).split('\n').length);
};

const unobservedSettlementAssertions = (text: string): number[] => {
  const lines: number[] = [];
  const settlement = /\bexpect(?:\.soft)?\(/g;
  for (;;) {
    const match = settlement.exec(text);
    if (match === null) return lines;
    const close = closingParenthesis(text, match.index + match[0].length - 1);
    if (close === -1) continue;
    if (!/^\s*\.(?:resolves|rejects)\b/.test(text.slice(close + 1, close + 40))) continue;
    const before = text.slice(Math.max(0, match.index - 200), match.index);
    if (OBSERVED_DIRECTLY.test(before)) continue;
    if (insideAwaitedAll(text, match.index)) continue;
    lines.push(text.slice(0, match.index).split('\n').length);
  }
};

describe('an assertion on the settlement of a promise is observed', () => {
  it('finds the assertion that is not awaited where it is created, and passes the awaited, the returned and the awaited Promise.all forms', () => {
    expect(unobservedSettlementAssertions("it('x', () => {\n  expect(run()).rejects.toThrow('no');\n});\n")).toEqual([2]);
    expect(unobservedSettlementAssertions("it('x', () => {\n  expect(run(a, (b))).resolves\n    .toBe(1);\n});\n")).toEqual([2]);
    expect(unobservedSettlementAssertions("it('x', async () => {\n  const later = expect(run()).rejects.toThrow();\n  stop();\n});\n")).toEqual([2]);
    expect(unobservedSettlementAssertions("it('x', async () => {\n  await expect(run()).rejects.toThrow();\n});\n")).toEqual([]);
    expect(unobservedSettlementAssertions("it('x', () => expect(run()).resolves.toBe(1));\n")).toEqual([]);
    expect(unobservedSettlementAssertions("it('x', () => {\n  return expect(run()).resolves.toBe(1);\n});\n")).toEqual([]);
    expect(unobservedSettlementAssertions("it('x', async () => {\n  const later = expect(run()).rejects.toThrow();\n  stop();\n  await later;\n});\n")).toEqual([2]);
    expect(unobservedSettlementAssertions("it('x', async () => {\n  await Promise.all([\n    expect(run()).rejects.toThrow(),\n    stop(),\n  ]);\n});\n")).toEqual([]);
    expect(unobservedSettlementAssertions("it('x', async () => {\n  Promise.all([expect(run()).rejects.toThrow()]);\n});\n")).toEqual([2]);
    expect(unobservedSettlementAssertions("it('x', async () => {\n  expect(await run()).toBe(1);\n});\n")).toEqual([]);
  });

  it('holds in every test file of the repository', () => {
    const own = path.join(ROOT, 'test', 'settlement-assertions-awaited.test.ts');
    const offenders = testSources()
      .filter((file) => file !== own)
      .flatMap((file) => unobservedSettlementAssertions(fs.readFileSync(file, 'utf8')).map((line) => `${path.relative(ROOT, file)}:${line}`));
    expect(offenders).toEqual([]);
  });
});

describe('a real process is owned before the call that starts it', () => {
  it('finds a start whose cleanup can only be registered after it, and passes a start handed to registerOwned as a function', () => {
    expect(unownedStarts("it('x', async (context) => {\n  const handle = await startGatewayProcess({ home });\n  registerCleanup(context, () => handle.close());\n});\n")).toEqual([2]);
    expect(unownedStarts("it('x', async () => {\n  const handle = await startRuntimeProcess({ home });\n  try {\n    use(handle);\n  } finally {\n    await handle.close();\n  }\n});\n")).toEqual([2]);
    expect(unownedStarts("it('x', async (context) => {\n  const error = await failureOf(startRuntimeProcess({ home }));\n});\n")).toEqual([2]);
    expect(unownedStarts("it('x', async (context) => {\n  const handle = await registerOwned(context, () => startSupervisor({ home }), (supervisor) => supervisor.abort());\n});\n")).toEqual([]);
    expect(unownedStarts("it('x', async (context) => {\n  const handle = await registerOwned(context, () => realWork.run(() => startSupervisor({ home })));\n});\n")).toEqual([]);
    expect(unownedStarts("it('x', async (context) => {\n  const error = await failureOf(registerOwned(context, () => startRuntimeProcess({ home })));\n});\n")).toEqual([]);
    expect(unownedStarts("type Handle = Awaited<ReturnType<typeof startGatewayProcess>>;\nconst handle = await original.startRuntimeProcess(options);\nexpect(scan(\"await startGatewayProcess({ home });\")).toBe(true);\n")).toEqual([]);
  });

  it('holds in every test file of the repository', () => {
    const own = path.join(ROOT, 'test', 'settlement-assertions-awaited.test.ts');
    const offenders = testSources()
      .filter((file) => file !== own)
      .flatMap((file) => unownedStarts(fs.readFileSync(file, 'utf8')).map((line) => `${path.relative(ROOT, file)}:${line}`));
    expect(offenders).toEqual([]);
  });
});
