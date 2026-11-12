import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = path.resolve(import.meta.dirname, '..');

const productSources = (): string[] => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(full);
    }
  };
  for (const pkg of fs.readdirSync(path.join(root, 'packages'))) {
    const src = path.join(root, 'packages', pkg, 'src');
    if (fs.existsSync(src)) walk(src);
  }
  return files;
};

const callArguments = (text: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  throw new Error('unbalanced call');
};

const callSites = (name: string): Array<{ file: string; args: string }> =>
  productSources().flatMap((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return [...text.matchAll(new RegExp(`(?<![\\w.])(?:options\\.)?${name}\\(`, 'g'))]
      .filter((match) => !/(?:export\s+(?:const|function)\s+|\bfunction\s+)$/.test(text.slice(Math.max(0, (match.index ?? 0) - 20), match.index)))
      .filter((match) => !/^\s*\w+\s*\(\s*options\s*:/.test(text.slice((match.index ?? 0) - 2, (match.index ?? 0) + name.length + 20)))
      .map((match) => ({ file: path.relative(root, file), args: callArguments(text, (match.index ?? 0) + match[0].length - 1) }));
  });

describe('every product launch of an MCP server carries a process marker (design 19.6 point 13, N343 item 3)', () => {
  it.each(['createPool', 'createStdioTransport'])('every product call of %s passes markers', (name) => {
    const sites = callSites(name);
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.filter(({ args }) => !/\bmarkers\b/.test(args)).map(({ file }) => file)).toEqual([]);
  });

  it('finds the MCP admin probe pool among the createPool calls', () => {
    expect(callSites('createPool').map(({ file }) => file)).toContain(path.join('packages', 'runtime', 'src', 'process', 'mcp-admin.ts'));
  });
});
