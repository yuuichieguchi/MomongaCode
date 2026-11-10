import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

const SCANNED = [path.join('packages', 'gateway', 'src', 'plan'), path.join('packages', 'foundation', 'src', 'encrypted-credential-store.ts')];

const CRYPTO_MODULE = String.raw`['"](?:node:)?crypto['"]`;

const ALLOWED_CRYPTO_IMPORTS: ReadonlySet<string> = new Set(['createHash', 'timingSafeEqual']);

const KEY_PAIR_FILE = 'packages/gateway/src/plan/host-identity.ts';

const ALLOWED_CRYPTO_MEMBERS = String.raw`subtle\.(?:importKey|encrypt|decrypt|digest)\b`;

const IMPORT_STATEMENT = new RegExp(String.raw`\bimport\s+(type\s+)?([^;'"]*?)\s+from\s+${CRYPTO_MODULE}`, 'g');

const LOADS = [new RegExp(String.raw`\brequire\(\s*${CRYPTO_MODULE}\s*\)`, 'g'), new RegExp(String.raw`\bimport\(\s*${CRYPTO_MODULE}\s*\)`, 'g')];

const MEMBER_USE = new RegExp(String.raw`(?<![\w$.])(?:globalThis\.)?crypto\.(?!${ALLOWED_CRYPTO_MEMBERS})`, 'g');

const HOST_RANDOM = [/\bMath\.random\b/g, /\bpromisify\(\s*randomBytes\s*\)/g];

const lineAt = (source: string, index: number): number => source.slice(0, index).split('\n').length;

const allowedImportsOf = (file: string): ReadonlySet<string> => (file === KEY_PAIR_FILE ? new Set([...ALLOWED_CRYPTO_IMPORTS, 'generateKeyPair']) : ALLOWED_CRYPTO_IMPORTS);

const importRefused = (clause: string, allowed: ReadonlySet<string>): boolean => {
  const named = /^\{([^}]*)\}$/.exec(clause.trim());
  if (named === null) return true;
  return named[1]!
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && !entry.startsWith('type '))
    .map((entry) => entry.split(/\s+as\s+/)[0]!.trim())
    .some((name) => !allowed.has(name));
};

const findingsOf = (file: string, source: string): string[] => {
  const allowed = allowedImportsOf(file);
  const indexes = [
    ...[...source.matchAll(IMPORT_STATEMENT)].filter((match) => match[1] === undefined && importRefused(match[2]!, allowed)).map((match) => match.index),
    ...[...LOADS, MEMBER_USE, ...HOST_RANDOM].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match.index)),
  ];
  return indexes.sort((a, b) => a - b).map((index) => `${file}:${lineAt(source, index)}`);
};

const filesUnder = (relative: string): string[] => {
  const absolute = path.join(ROOT, relative);
  if (fs.statSync(absolute).isFile()) return [relative];
  return fs
    .readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => path.join(relative, name))
    .sort();
};

const repoRelative = (file: string): string => file.split(path.sep).join('/');

describe('O-R5-6 L8: the plan files take their random through a port', () => {
  it('no Math.random and no promisify(randomBytes) in gateway/src/plan and foundation/src/encrypted-credential-store.ts', () => {
    const found = SCANNED.flatMap(filesUnder).flatMap((file) => findingsOf(repoRelative(file), fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(found).toEqual([]);
  });

  it('recognises every form the scan must catch', () => {
    const table: ReadonlyArray<readonly [string, number]> = [
      ["import { randomBytes } from 'node:crypto'", 1],
      ["import { randomUUID, createHash } from 'crypto'", 1],
      ["import * as crypto from 'node:crypto'", 1],
      ["import crypto from 'node:crypto'", 1],
      ["const c = await import('node:crypto')", 1],
      ['crypto.randomUUID()', 1],
      ['globalThis.crypto.getRandomValues(a)', 1],
      ["import { generateKey } from 'node:crypto'", 1],
      ["import { createHash, timingSafeEqual } from 'node:crypto'", 0],
      ["import type { webcrypto } from 'node:crypto'", 0],
      ['globalThis.crypto.subtle.encrypt(x)', 0],
    ];
    expect(table.map(([source]) => [source, findingsOf('packages/gateway/src/plan/x.ts', source).length])).toEqual(table);
  });

  it('allows generateKeyPair only in host-identity.ts', () => {
    const source = "import { generateKeyPair } from 'node:crypto'";
    expect(findingsOf(KEY_PAIR_FILE, source)).toEqual([]);
    expect(findingsOf('packages/gateway/src/plan/signin.ts', source)).toEqual(['packages/gateway/src/plan/signin.ts:1']);
    expect(findingsOf('packages/foundation/src/encrypted-credential-store.ts', source)).toEqual(['packages/foundation/src/encrypted-credential-store.ts:1']);
  });
});
