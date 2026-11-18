import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PACKAGES = path.join(ROOT, 'packages');

export type ConstantRow = { readonly file: string; readonly line: number; readonly name: string; readonly value: string; readonly cells: readonly string[] };

export type CellValue =
  | { readonly kind: 'value'; readonly value: number | boolean | string }
  | { readonly kind: 'reference'; readonly name: string }
  | { readonly kind: 'unchecked'; readonly reason: string }
  | { readonly kind: 'unreadable' };

export type RowFailure = { readonly row: ConstantRow; readonly reason: string };

export type RowsOutcome = { readonly checked: number; readonly unchecked: number; readonly failures: readonly RowFailure[] };

const NAME_HEADERS = new Set(['Name', 'Constant']);
const UNCHECKED_MARK = /^unchecked:\s*(.+)$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const CALL = /^([A-Za-z_$][\w$]*)\((.*)\)$/;

const UNIT_FACTORS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
  B: 1,
  bytes: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  tokens: 1,
  characters: 1,
  chars: 1,
  entries: 1,
  lines: 1,
  files: 1,
  rows: 1,
  attempts: 1,
};

const NUMBER = /^(-?(?:0x[0-9a-fA-F]+|0o[0-7]+|\d[\d_,]*(?:\.\d+)?(?:e[+-]?\d+)?))(?:\s+([A-Za-z]+))?(?=\s|$|\s*\()/;

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
  if (text === 'true' || text === 'false') return { kind: 'value', value: text === 'true' };
  const number = NUMBER.exec(text);
  if (number !== null && number[0] === text.trim()) {
    const unit = number[2];
    if (unit === undefined) return { kind: 'value', value: numberOf(number[1] as string) };
    const factor = UNIT_FACTORS[unit];
    return factor === undefined ? { kind: 'unreadable' } : { kind: 'value', value: numberOf(number[1] as string) * factor };
  }
  return { kind: 'unreadable' };
};

export const parseValueCell = (cell: string): CellValue => {
  const unchecked = UNCHECKED_MARK.exec(cell);
  if (unchecked !== null) return { kind: 'unchecked', reason: (unchecked[1] as string).trim() };
  const quoted = /^`([^`]+)`(.*)$/.exec(cell);
  if (quoted !== null) {
    const inner = (quoted[1] as string).trim();
    const literal = literalOf(inner);
    if (literal.kind === 'value') return literal;
    if (/^[A-Z][A-Z0-9_]*$/.test(inner)) return { kind: 'reference', name: inner };
    const quotedString = /^(['"])(.*)\1$/.exec(inner);
    return { kind: 'value', value: quotedString === null ? inner : (quotedString[2] as string) };
  }
  const number = NUMBER.exec(cell);
  if (number !== null) {
    const literal = literalOf(number[0]);
    if (literal.kind === 'value') return literal;
  }
  if (/^(true|false)\b/.test(cell)) return { kind: 'value', value: cell.startsWith('true') };
  return { kind: 'unreadable' };
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

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !entry.name.includes('.generated.') ? [full] : [];
  });

let declarations: Map<string, string[]> | undefined;

const declarationsOf = (): Map<string, string[]> => {
  if (declarations !== undefined) return declarations;
  const found = new Map<string, string[]>();
  for (const pkg of fs.readdirSync(PACKAGES)) {
    const src = path.join(PACKAGES, pkg, 'src');
    if (!fs.existsSync(src)) continue;
    for (const file of sourceFiles(src)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)) {
        const name = match[1] as string;
        found.set(name, [...(found.get(name) ?? []), file]);
      }
    }
  }
  declarations = found;
  return found;
};

const shown = (value: unknown): string => (typeof value === 'string' ? JSON.stringify(value) : typeof value === 'bigint' ? `${value}n` : String(value));

class Unresolved extends Error {}

const exportOf = async (name: string, row: ConstantRow): Promise<unknown> => {
  const [head, ...rest] = name.split('.');
  const files = declarationsOf().get(head as string) ?? [];
  if (files.length === 0) throw new Unresolved(`${head} is not exported by any product module`);
  const mentioned = files.filter((file) => row.cells.some((cell) => cell.includes(path.relative(ROOT, file))) || row.cells.some((cell) => cell.includes(path.relative(PACKAGES, file).replace(/^[^/]+\/src\//, ''))));
  const chosen = files.length === 1 ? files : mentioned;
  if (chosen.length !== 1) throw new Unresolved(`${head} is exported by ${files.length} modules (${files.map((file) => path.relative(ROOT, file)).join(', ')}); name its file in the row`);
  const module = (await import(pathToFileURL(chosen[0] as string).href)) as Record<string, unknown>;
  let value: unknown = module[head as string];
  for (const key of rest) {
    if (value === null || typeof value !== 'object' || !(key in value)) throw new Unresolved(`${name} does not resolve: ${key} is not a property`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
};

const argumentOf = async (text: string, row: ConstantRow): Promise<unknown> => {
  const literal = literalOf(text);
  if (literal.kind === 'value') return literal.value;
  if (IDENTIFIER.test(text)) return exportOf(text, row);
  throw new Unresolved(`the argument ${text} is neither a number nor an exported name`);
};

const codeValueOf = async (row: ConstantRow): Promise<unknown> => {
  const call = CALL.exec(row.name);
  if (call !== null) {
    const fn = await exportOf(call[1] as string, row);
    if (typeof fn !== 'function') throw new Unresolved(`${call[1]} is not a function`);
    const text = (call[2] as string).trim();
    const args = text === '' ? [] : await Promise.all(text.split(',').map((part) => argumentOf(part.trim(), row)));
    try {
      return (fn as (...values: unknown[]) => unknown)(...args);
    } catch (error) {
      throw new Unresolved(`${row.name} throws when called with the stated arguments: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!IDENTIFIER.test(row.name)) throw new Unresolved(`the name ${row.name} is not an exported constant or a call of an exported function`);
  return exportOf(row.name, row);
};

const sameValue = (document: unknown, code: unknown): boolean => {
  if (typeof code === 'bigint' && typeof document === 'number') return BigInt(document) === code;
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
      const document = parsed.kind === 'reference' ? await exportOf(parsed.name, row) : parsed.value;
      if (!sameValue(document, code)) throw new Unresolved(`the document says ${shown(document)}, the code says ${shown(code)}`);
      checked += 1;
    } catch (error) {
      if (!(error instanceof Unresolved)) throw error;
      failures.push({ row, reason: error.message });
    }
  }
  return { checked, unchecked, failures };
};
