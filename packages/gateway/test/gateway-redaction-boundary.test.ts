import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

const relative = (file: string): string => path.relative(srcDir, file).split(path.sep).join('/');

const sources = sourceFiles(srcDir).map((file) => ({ file, name: relative(file), text: fs.readFileSync(file, 'utf8') }));

const countOf = (text: string, pattern: RegExp): number => [...text.matchAll(pattern)].length;

const IMPORT_LINE = /^\s*(?:import|export)\b[^;]*\bfrom\s*['"][^'"]+['"]/;

const codeLines = (text: string): Array<{ number: number; line: string }> =>
  text
    .split('\n')
    .map((line, index) => ({ number: index + 1, line }))
    .filter(({ line }) => !IMPORT_LINE.test(line));

const importedPaths = (file: string, text: string): string[] =>
  [...text.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => relative(path.resolve(path.dirname(file), specifier)));

const withoutCall = (text: string, callee: string): string => {
  let rest = text;
  for (let start = rest.indexOf(callee); start >= 0; start = rest.indexOf(callee)) {
    let depth = 0;
    let end = start + callee.length - 1;
    for (; end < rest.length; end += 1) {
      if (rest[end] === '(') depth += 1;
      if (rest[end] === ')') depth -= 1;
      if (depth === 0) break;
    }
    rest = rest.slice(0, start) + rest.slice(end + 1);
  }
  return rest;
};

const RAW_MAP_FILES = ['core/router.ts', 'process.ts', 'server/config-check.ts', 'server/gateway.ts', 'types.ts'];

describe('S1: upstream text crosses one redaction boundary', () => {
  it('calls guardAdapter exactly once under src, in core/router.ts', () => {
    const calls = sources
      .map(({ name, text }) => ({ name, count: countOf(text, /(?<!function\s+)\bguardAdapter\(/g) }))
      .filter(({ count }) => count > 0);
    expect(calls).toEqual([{ name: 'core/router.ts', count: 1 }]);
  });

  it('wraps every raw adapter the router reads in guardAdapter', () => {
    const router = sources.find(({ name }) => name === 'core/router.ts')?.text ?? '';
    expect(countOf(router, /requireEntry\(\s*adapters\b/g)).toBe(1);
    expect(countOf(router, /guardAdapter\(\s*requireEntry\(\s*adapters\b/g)).toBe(1);
  });

  it('calls redactor.text only in core/guarded-adapter.ts', () => {
    const files = sources.filter(({ text }) => /\bredactor\.text\b/.test(text)).map(({ name }) => name);
    expect(files).toEqual(['core/guarded-adapter.ts']);
  });

  it('casts to GuardedAdapter nowhere outside core/guarded-adapter.ts', () => {
    const files = sources.filter(({ name, text }) => name !== 'core/guarded-adapter.ts' && /\bas\s+GuardedAdapter\b/.test(text)).map(({ name }) => name);
    expect(files).toEqual([]);
  });

  it('narrows failureFrom to a GuardedAdapter', () => {
    const retry = sources.find(({ name }) => name === 'core/retry.ts')?.text ?? '';
    expect(retry).toMatch(/failureFrom = \(\s*adapter\s*:\s*GuardedAdapter\b/);
  });

  it('reads the raw adapter map only at the allowed sites', () => {
    const outside = sources
      .filter(({ name }) => !RAW_MAP_FILES.includes(name))
      .flatMap(({ name, text }) =>
        codeLines(text)
          .filter(({ line }) => /\b(?:options\.adapters|adapters\s*:\s*options\.adapters)\b/.test(line))
          .map(({ number, line }) => `${name}:${number}: ${line.trim()}`),
      );
    expect(outside).toEqual([]);
    const gateway = sources.find(({ name }) => name === 'server/gateway.ts')?.text ?? '';
    expect(withoutCall(gateway.replaceAll('closeAdapters(options.adapters)', ''), 'createRouter(')).not.toMatch(/\boptions\.adapters\b/);
    const process = sources.find(({ name }) => name === 'process.ts')?.text ?? '';
    const processUses = codeLines(process)
      .filter(({ line }) => /\badapters\b/.test(line))
      .map(({ line }) => line.trim())
      .filter(
        (line) =>
          !/^const adapters: Record<string, ProviderAdapter> = \{\};$/.test(line) &&
          !/Object\.values\(adapters\)\.map\(\(adapter\) => adapter\.close\?\.\(\)\)/.test(line) &&
          !/^adapters\[name\] = /.test(line) &&
          !/^adapters,$/.test(line),
      );
    expect(processUses).toEqual([]);
    const configCheck = sources.find(({ name }) => name === 'server/config-check.ts')?.text ?? '';
    const configUses = codeLines(configCheck)
      .filter(({ line }) => /\badapters\b/.test(line))
      .map(({ line }) => line.trim())
      .filter(
        (line) =>
          !/^if \(!\('epochs' in options\)\) checkModels\(\{ config: options\.config, adapterNames: new Set\(Object\.keys\(options\.adapters\)\) \}\);$/.test(line),
      );
    expect(configUses).toEqual([]);
  });

  it('keeps src/adapters and src/managed from importing core/errors.ts', () => {
    const offenders = sources
      .filter(({ name }) => name.startsWith('adapters/') || name.startsWith('managed/'))
      .filter(({ file, text }) => importedPaths(file, text).includes('core/errors.ts'))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });
});
