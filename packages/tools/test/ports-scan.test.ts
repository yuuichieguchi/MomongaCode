import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(import.meta.dirname, '..', 'src');

const ADAPTERS: Readonly<Record<string, string>> = {
  'node-ports.ts': 'the one production adapter module of tools: the child-and-timer port, the shell host and the host-bound factories built from them',
};

const TOKENS: Readonly<Record<string, RegExp>> = {
  'node:child_process': /['"]node:child_process['"]/g,
  'node:fs': /['"]node:fs(?:\/promises)?['"]/g,
  'node:zlib': /['"]node:zlib['"]/g,
  setTimeout: /(?<![\w.$'"])(?:setTimeout|setInterval|setImmediate|clearTimeout|clearInterval)\b(?!\s*[(<]?[^\n]*\)\s*:)/g,
  'Math.random': /\bMath\.random\b/g,
  randomBytes: /(?<![\w.$])(?:randomBytes|randomUUID|randomInt)\b/g,
  'process.env': /(?<![\w.$])process\.env\b/g,
  'Date.now': /\bDate\.now\b/g,
  'adapter import': /['"](?:\.\.?\/)+node-ports\.ts['"]/g,
};

const ADAPTER_IMPORTERS: ReadonlySet<string> = new Set(['index.ts']);

const TYPE_IMPORT = /^import type [^;]*;$/gm;

const bypassesOf = (relative: string, source: string): string[] => {
  const code = source.replace(TYPE_IMPORT, '');
  return Object.entries(TOKENS)
    .filter(([token]) => !(token === 'adapter import' && ADAPTER_IMPORTERS.has(relative)))
    .filter(([, pattern]) => [...code.matchAll(pattern)].length > 0)
    .map(([token]) => token);
};

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

const relativeOf = (file: string): string => path.relative(SOURCE_ROOT, file).split(path.sep).join('/');

describe('tools reaches time, randomness, processes and the file system only through its ports', () => {
  it('reports each direct use and passes a port call and a port member (negative control)', () => {
    expect(bypassesOf('a.ts', "import { spawn } from 'node:child_process';")).toEqual(['node:child_process']);
    expect(bypassesOf('a.ts', "import fs from 'node:fs';")).toEqual(['node:fs']);
    expect(bypassesOf('a.ts', "import fsp from 'node:fs/promises';")).toEqual(['node:fs']);
    expect(bypassesOf('a.ts', "import { brotliDecompressSync } from 'node:zlib';")).toEqual(['node:zlib']);
    expect(bypassesOf('a.ts', 'const handle = setTimeout(finish, ms);')).toEqual(['setTimeout']);
    expect(bypassesOf('a.ts', 'clearTimeout(handle);')).toEqual(['setTimeout']);
    expect(bypassesOf('a.ts', 'let timer: ReturnType<typeof setTimeout> | undefined;')).toEqual(['setTimeout']);
    expect(bypassesOf('a.ts', 'const jitter = Math.random();')).toEqual(['Math.random']);
    expect(bypassesOf('a.ts', 'computeBackoff({ random: Math.random });')).toEqual(['Math.random']);
    expect(bypassesOf('a.ts', "const nonce = randomBytes(16).toString('hex');")).toEqual(['randomBytes']);
    expect(bypassesOf('a.ts', "const home = process.env['HOME'];")).toEqual(['process.env']);
    expect(bypassesOf('a.ts', 'const now = Date.now();')).toEqual(['Date.now']);
    expect(bypassesOf('builtins/bash.ts', "import { nodeShellPorts } from '../node-ports.ts';")).toEqual(['adapter import']);
    expect(bypassesOf('index.ts', "export { nodeShellHost } from './node-ports.ts';")).toEqual([]);
    expect(bypassesOf('a.ts', 'const handle = ports.setTimeout(finish, ms);\nports.clearTimeout(handle);')).toEqual([]);
    expect(bypassesOf('a.ts', '  setTimeout(callback: () => void, ms: number): unknown;\n  clearTimeout(handle: unknown): void;')).toEqual([]);
    expect(bypassesOf('a.ts', "import type { Stats } from 'node:fs';\nexport type Timers = Pick<ChildPorts, 'setTimeout' | 'clearTimeout'>;")).toEqual([]);
    expect(bypassesOf('a.ts', 'const nonce = ctx.random.hex(16);\nconst now = ctx.clock.now();')).toEqual([]);
  });

  it('every listed adapter exists and carries its reason', () => {
    for (const [file, reason] of Object.entries(ADAPTERS)) {
      expect(fs.existsSync(path.join(SOURCE_ROOT, file)), file).toBe(true);
      expect(reason.trim()).not.toBe('');
    }
  });

  it('no module outside the adapter uses the host directly', () => {
    const found = Object.fromEntries(
      sourceFiles(SOURCE_ROOT)
        .map((file) => [relativeOf(file), file] as const)
        .filter(([relative]) => !(relative in ADAPTERS))
        .map(([relative, file]) => [relative, bypassesOf(relative, fs.readFileSync(file, 'utf8'))] as const)
        .filter(([, tokens]) => tokens.length > 0),
    );
    expect(found).toEqual({});
  });
});
