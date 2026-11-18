import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { programOf } from './source-scan.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PACKAGES = path.join(ROOT, 'packages');

export type ConstantRow = { readonly file: string; readonly line: number; readonly name: string; readonly value: string; readonly cells: readonly string[] };

export type CellValue =
  | { readonly kind: 'value'; readonly value: number | boolean | string | readonly unknown[] | Readonly<Record<string, unknown>> }
  | { readonly kind: 'reference'; readonly name: string }
  | { readonly kind: 'unchecked'; readonly reason: string }
  | { readonly kind: 'unreadable' };

export type RowFailure = { readonly row: ConstantRow; readonly reason: string };

export type RowsOutcome = { readonly checked: number; readonly unchecked: number; readonly failures: readonly RowFailure[] };

const NAME_HEADERS = new Set(['Name', 'Constant']);
const UNCHECKED_MARK = /^unchecked:\s*(.+)$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const CALL = /^([A-Za-z_$][\w$]*)\((.*)\)((?:\.[A-Za-z_$][\w$]*)*)$/;

const UNIT_FACTORS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  seconds: 1000,
  min: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hours: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
};

const NOT_UNITS = new Set(['and', 'or', 'to', 'of', 'x', 'plus', 'minus', 'times', 'per', 'is', 'at']);

const NUMBER = /^(-?(?:0x[0-9a-fA-F]+|0o[0-7]+|\d[\d_,]*(?:\.\d+)?(?:e[+-]?\d+)?))(?:\s+([A-Za-z]{2,}|s|h|B))?/;

const unitFactorOf = (unit: string | undefined): number | undefined => {
  if (unit === undefined) return 1;
  if (NOT_UNITS.has(unit)) return undefined;
  return UNIT_FACTORS[unit] ?? (/^[a-z]{2,}$/.test(unit) ? 1 : undefined);
};

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());

const numberOf = (text: string): number => {
  const plain = text.replace(/[_,]/g, '');
  if (/^-?0o/.test(plain)) return Number.parseInt(plain.replace('0o', ''), 8) * (plain.startsWith('-') ? -1 : 1);
  return Number(plain);
};

const literalOf = (text: string): CellValue => {
  const trimmed = text.trim();
  if (trimmed === 'true' || trimmed === 'false') return { kind: 'value', value: trimmed === 'true' };
  const number = NUMBER.exec(trimmed);
  if (number === null) return { kind: 'unreadable' };
  const unit = number[2];
  const factor = unitFactorOf(unit);
  const rest = trimmed.slice(number[0].length);
  const restAllowed = rest === '' || /^\s*\(/.test(rest) || (unit !== undefined && factor !== undefined && /^\s/.test(rest));
  if (factor === undefined || !restAllowed) return { kind: 'unreadable' };
  return { kind: 'value', value: numberOf(number[1] as string) * factor };
};

export const parseValueCell = (cell: string): CellValue => {
  const unchecked = UNCHECKED_MARK.exec(cell);
  if (unchecked !== null) return { kind: 'unchecked', reason: (unchecked[1] as string).trim() };
  const listed = /^`[^`]+`(?:, `[^`]+`)+$/.test(cell) ? [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string) : undefined;
  if (listed !== undefined) return { kind: 'value', value: listed.map((item) => { const literal = literalOf(item); return literal.kind === 'value' ? literal.value : item; }) };
  const json = /^`([[{].*[\]}])`$/.exec(cell);
  if (json !== null) {
    try {
      return { kind: 'value', value: JSON.parse(json[1] as string) as Readonly<Record<string, unknown>> };
    } catch {
      return { kind: 'unreadable' };
    }
  }
  const quoted = /^`([^`]+)`(.*)$/.exec(cell);
  if (quoted !== null) {
    const inner = (quoted[1] as string).trim();
    const literal = literalOf(inner);
    if (literal.kind === 'value') return literal;
    if (/^[A-Z][A-Z0-9_]*$/.test(inner)) return { kind: 'reference', name: inner };
    const quotedString = /^(['"])(.*)\1$/.exec(inner);
    return { kind: 'value', value: quotedString === null ? inner : (quotedString[2] as string) };
  }
  return literalOf(cell);
};

export const constantRowsOf = (file: string, text: string): ConstantRow[] => {
  const lines = text.split('\n');
  const rows: ConstantRow[] = [];
  let valueColumn: number | undefined;
  lines.forEach((line, index) => {
    if (!line.trim().startsWith('|')) {
      valueColumn = undefined;
      return;
    }
    const cells = cellsOf(line);
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return;
    const header = cells[0] !== undefined && NAME_HEADERS.has(cells[0]) ? cells.findIndex((cell) => /^Value\b/.test(cell)) : -1;
    if (header > 0) {
      valueColumn = header;
      return;
    }
    if (valueColumn === undefined) return;
    const nameCell = cells[0] ?? '';
    const name = /`([^`]+)`/.exec(nameCell)?.[1] ?? nameCell;
    rows.push({ file, line: index + 1, name, value: cells[valueColumn] ?? '', cells });
  });
  return rows;
};

const SOURCE_ROOTS = ['scripts', 'e2e', 'test'];

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'fixtures' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !entry.name.includes('.generated.') ? [full] : [];
  });

const codeFiles = (): string[] => [
  ...fs.readdirSync(PACKAGES).flatMap((pkg) => ['src', 'test'].map((part) => path.join(PACKAGES, pkg, part)).filter((directory) => fs.existsSync(directory)).flatMap(sourceFiles)),
  ...SOURCE_ROOTS.map((root) => path.join(ROOT, root)).filter((root) => fs.existsSync(root)).flatMap(sourceFiles),
  path.join(ROOT, 'vitest.config.ts'),
];

const importable = (file: string): boolean => {
  const parts = path.relative(ROOT, file).split(path.sep);
  return ((parts[0] === 'packages' && parts[2] === 'src') || parts[0] === 'scripts') && !/\.test\.tsx?$/.test(file);
};

type Declaration = { readonly file: string; readonly exported: boolean };

let declarations: Map<string, Declaration[]> | undefined;

const declarationsOf = (): Map<string, Declaration[]> => {
  if (declarations !== undefined) return declarations;
  const found = new Map<string, Declaration[]>();
  for (const file of codeFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^(export\s+)?(?:async\s+)?(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = match[2] as string;
      found.set(name, [...(found.get(name) ?? []), { file, exported: match[1] !== undefined && importable(file) }]);
    }
  }
  declarations = found;
  return found;
};

const shown = (value: unknown): string => {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `a function ${value.name}`;
  if (typeof value === 'object' && value !== null) return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? `${item}n` : item));
  return String(value);
};

class Unresolved extends Error {}

const mentions = (row: ConstantRow, file: string): boolean => {
  const relative = path.relative(ROOT, file).split(path.sep);
  const suffixes = relative.map((_part, index) => relative.slice(index).join('/'));
  return row.cells.some((cell) => suffixes.some((suffix) => cell.includes(suffix)));
};

const modules = new Map<string, Promise<Record<string, unknown>>>();

const moduleAt = (specifier: string): Promise<Record<string, unknown>> => {
  const known = modules.get(specifier);
  if (known !== undefined) return known;
  const loading = import(specifier) as Promise<Record<string, unknown>>;
  modules.set(specifier, loading);
  return loading;
};

type Node = { readonly type: string; readonly [key: string]: unknown };

const programs = new Map<string, Node>();

const programAt = (file: string): Node => {
  const known = programs.get(file);
  if (known !== undefined) return known;
  const program = programOf(file, fs.readFileSync(file, 'utf8')) as Node;
  programs.set(file, program);
  return program;
};

const bodyOf = (file: string): Node[] => programAt(file)['body'] as Node[];

const declaredInit = (file: string, name: string): Node | undefined => {
  for (const statement of bodyOf(file)) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? (statement['declaration'] as Node | null) : statement;
    if (declaration === null || declaration === undefined || declaration.type !== 'VariableDeclaration') continue;
    for (const declarator of declaration['declarations'] as Node[]) {
      const id = declarator['id'] as Node;
      if (id.type === 'Identifier' && id['name'] === name) return (declarator['init'] as Node | null) ?? undefined;
    }
  }
  return undefined;
};

const importOf = (file: string, name: string): { readonly specifier: string; readonly imported: string; readonly source?: string } | undefined => {
  for (const statement of bodyOf(file)) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = String((statement['source'] as Node)['value']);
    for (const specifier of statement['specifiers'] as Node[]) {
      if ((specifier['local'] as Node)['name'] !== name) continue;
      const imported = specifier.type === 'ImportSpecifier' ? String((specifier['imported'] as Node)['name'] ?? (specifier['imported'] as Node)['value']) : '*';
      if (!source.startsWith('.')) return { specifier: source, imported };
      const target = path.resolve(path.dirname(file), source);
      return { specifier: pathToFileURL(target).href, imported, source: target };
    }
  }
  return undefined;
};

const MATH: Readonly<Record<string, (...values: number[]) => number>> = { min: Math.min, max: Math.max, ceil: Math.ceil, floor: Math.floor, round: Math.round, trunc: Math.trunc, abs: Math.abs };

const BINARY: Readonly<Record<string, (left: never, right: never) => unknown>> = {
  '+': (left, right) => (left as number) + (right as number),
  '-': (left, right) => (left as number) - (right as number),
  '*': (left, right) => (left as number) * (right as number),
  '/': (left, right) => (left as number) / (right as number),
  '%': (left, right) => (left as number) % (right as number),
  '**': (left, right) => (left as number) ** (right as number),
};

const GLOBALS: Readonly<Record<string, unknown>> = { Object, Number, String, Math, Infinity };

const identifierIn = async (file: string, name: string, row: ConstantRow): Promise<unknown> => {
  const init = declaredInit(file, name);
  if (init === undefined && name in GLOBALS) return GLOBALS[name];
  if (init !== undefined) return evaluate(file, init, row);
  const imported = importOf(file, name);
  if (imported === undefined) throw new Unresolved(`${name} in ${path.relative(ROOT, file)} is neither a top-level const of that file nor imported by it`);
  if (imported.source !== undefined && !importable(imported.source)) {
    if (imported.imported === '*') throw new Unresolved(`${name} in ${path.relative(ROOT, file)} is a namespace of a test module`);
    return identifierIn(imported.source, imported.imported, row);
  }
  const module = await moduleAt(imported.specifier);
  return imported.imported === '*' ? module : module[imported.imported];
};

const argumentsOf = async (file: string, nodes: readonly Node[], row: ConstantRow): Promise<unknown[]> => {
  const values: unknown[] = [];
  for (const node of nodes) {
    if (node.type !== 'SpreadElement') values.push(await evaluate(file, node, row));
    else values.push(...((await evaluate(file, node['argument'] as Node, row)) as Iterable<unknown>));
  }
  return values;
};

const evaluate = async (file: string, node: Node, row: ConstantRow): Promise<unknown> => {
  switch (node.type) {
    case 'Literal':
      return node['value'];
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'ParenthesizedExpression':
      return evaluate(file, node['expression'] as Node, row);
    case 'UnaryExpression': {
      const value = await evaluate(file, node['argument'] as Node, row);
      if (node['operator'] === '-') return -(value as number);
      if (node['operator'] === '+') return +(value as number);
      break;
    }
    case 'BinaryExpression': {
      const operation = BINARY[String(node['operator'])];
      if (operation === undefined) break;
      return operation((await evaluate(file, node['left'] as Node, row)) as never, (await evaluate(file, node['right'] as Node, row)) as never);
    }
    case 'TemplateLiteral': {
      const quasis = (node['quasis'] as Node[]).map((quasi) => String((quasi['value'] as { cooked: string }).cooked));
      const values = await Promise.all((node['expressions'] as Node[]).map((expression) => evaluate(file, expression, row)));
      return quasis.reduce((text, quasi, index) => `${text}${quasi}${index < values.length ? String(values[index]) : ''}`, '');
    }
    case 'Identifier':
      return identifierIn(file, String(node['name']), row);
    case 'MemberExpression': {
      const object = await evaluate(file, node['object'] as Node, row);
      const property = node['computed'] === true ? await evaluate(file, node['property'] as Node, row) : (node['property'] as Node)['name'];
      if (typeof object === 'string' && property === 'length') return object.length;
      if (object === null || typeof object !== 'object' && typeof object !== 'function') break;
      return (object as Record<string, unknown>)[String(property)];
    }
    case 'CallExpression': {
      const callee = node['callee'] as Node;
      if (callee.type === 'MemberExpression' && (callee['object'] as Node)['name'] === 'Math') {
        const operation = MATH[String((callee['property'] as Node)['name'])];
        if (operation === undefined) break;
        return operation(...((await argumentsOf(file, node['arguments'] as Node[], row)) as number[]));
      }
      const fn = await evaluate(file, callee, row);
      if (typeof fn !== 'function') break;
      return (fn as (...args: unknown[]) => unknown)(...(await argumentsOf(file, node['arguments'] as Node[], row)));
    }
    case 'NewExpression': {
      const callee = node['callee'] as Node;
      if (callee.type !== 'Identifier' || callee['name'] !== 'Set') break;
      const items = (node['arguments'] as Node[])[0];
      return new Set(items === undefined ? [] : ((await evaluate(file, items, row)) as unknown[]));
    }
    case 'ArrayExpression':
      return argumentsOf(file, node['elements'] as Node[], row);
    case 'ObjectExpression': {
      const entries: [string, unknown][] = [];
      for (const property of node['properties'] as Node[]) {
        if (property.type !== 'Property') throw new Unresolved(`the value of ${row.name} in ${path.relative(ROOT, file)} spreads another object`);
        const key = property['key'] as Node;
        entries.push([String(key['name'] ?? key['value']), await evaluate(file, property['value'] as Node, row)]);
      }
      return Object.fromEntries(entries);
    }
    default:
      break;
  }
  throw new Unresolved(`the value of ${row.name} in ${path.relative(ROOT, file)} is not a constant expression (${node.type})`);
};

const exportOf = async (name: string, row: ConstantRow): Promise<unknown> => {
  const [head, ...rest] = name.split('.');
  const found = declarationsOf().get(head as string) ?? [];
  if (found.length === 0) throw new Unresolved(`${head} is declared at the top level of no product module`);
  const named = found.filter((declaration) => mentions(row, declaration.file));
  const exported = found.filter((declaration) => declaration.exported);
  const product = exported.filter((entry) => path.relative(PACKAGES, entry.file).split(path.sep)[1] === 'src');
  const chosen = named.length === 1 ? named : named.length > 1 ? [] : exported.length === 1 ? exported : product.length === 1 ? product : [];
  const declaration = chosen[0];
  if (declaration === undefined) {
    const where = found.map((entry) => `${path.relative(ROOT, entry.file)}${entry.exported ? '' : ' (not exported)'}`).join(', ');
    throw new Unresolved(found.length === 1 ? `${head} is a constant of ${where} only: name that file in the row` : `${head} is declared in ${found.length} modules (${where}); name its file in the row`);
  }
  let value: unknown = declaration.exported ? (await moduleAt(pathToFileURL(declaration.file).href))[head as string] : await identifierIn(declaration.file, head as string, row);
  for (const key of rest) {
    if (value === null || typeof value !== 'object' || !(key in value)) throw new Unresolved(`${name} does not resolve: ${key} is not a property`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
};

const argumentOf = async (text: string, row: ConstantRow): Promise<unknown> => {
  const literal = literalOf(text);
  if (literal.kind === 'value') return literal.value;
  const quoted = /^(['"])(.*)\1$/.exec(text);
  if (quoted !== null) return quoted[2];
  if (/^[[{]/.test(text)) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Unresolved(`the argument ${text} is not JSON`);
    }
  }
  if (IDENTIFIER.test(text)) return exportOf(text, row);
  throw new Unresolved(`the argument ${text} is neither a number nor an exported name`);
};

const topLevelParts = (text: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  [...text].forEach((character, index) => {
    if (character === '[' || character === '{' || character === '(') depth += 1;
    if (character === ']' || character === '}' || character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  });
  return [...parts, text.slice(start)];
};

const codeValueOf = async (row: ConstantRow): Promise<unknown> => {
  const call = CALL.exec(row.name);
  if (call !== null) {
    const fn = await exportOf(call[1] as string, row);
    if (typeof fn !== 'function') throw new Unresolved(`${call[1]} is not a function`);
    const text = (call[2] as string).trim();
    const args = text === '' ? [] : await Promise.all(topLevelParts(text).map((part) => argumentOf(part.trim(), row)));
    try {
      let value: unknown = (fn as (...values: unknown[]) => unknown)(...args);
      for (const key of (call[3] as string).split('.').filter((part) => part !== '')) {
        if (value === null || typeof value !== 'object' || !(key in value)) throw new Unresolved(`${row.name} does not resolve: ${key} is not a property`);
        value = (value as Record<string, unknown>)[key];
      }
      return value;
    } catch (error) {
      if (error instanceof Unresolved) throw error;
      throw new Unresolved(`${row.name} throws when called with the stated arguments: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!IDENTIFIER.test(row.name)) throw new Unresolved(`the name ${row.name} is not an exported constant or a call of an exported function`);
  return exportOf(row.name, row);
};

const canonical = (value: unknown): unknown => {
  if (value instanceof Set) return [...value].map(canonical);
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'bigint') return Number(value);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([first], [second]) => (first < second ? -1 : 1)).map(([key, item]) => [key, canonical(item)]));
  return value;
};

const sameValue = (document: unknown, code: unknown): boolean => {
  if (typeof code === 'bigint' && typeof document === 'number') return BigInt(document) === code;
  if (typeof document === 'object' && document !== null) return JSON.stringify(canonical(document)) === JSON.stringify(canonical(code));
  return Object.is(document, code) || document === code;
};

export const checkRows = async (rows: readonly ConstantRow[]): Promise<RowsOutcome> => {
  let checked = 0;
  let unchecked = 0;
  const failures: RowFailure[] = [];
  for (const row of rows) {
    const parsed = parseValueCell(row.value);
    if (parsed.kind === 'unchecked') {
      unchecked += 1;
      continue;
    }
    try {
      if (parsed.kind === 'unreadable') throw new Unresolved(`the value ${JSON.stringify(row.value)} is not a checkable value; write the value, or mark the row \`unchecked: <reason>\``);
      const code = await codeValueOf(row);
      const inSeconds = parsed.kind === 'value' && /(?:_SECONDS|Seconds)(?:\(|$)/.test(row.name) && typeof parsed.value === 'number' && / (?:s|seconds)\b/.test(row.value);
      const document = parsed.kind === 'reference' ? await exportOf(parsed.name, row) : inSeconds ? (parsed.value as number) / 1000 : parsed.value;
      if (!sameValue(document, code)) throw new Unresolved(`the document says ${shown(document)}, the code says ${shown(code)}`);
      checked += 1;
    } catch (error) {
      if (!(error instanceof Unresolved)) throw error;
      failures.push({ row, reason: error.message });
    }
  }
  return { checked, unchecked, failures };
};
