import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');

type Increment = 'N1' | 'N2' | 'N3a' | 'N3b' | 'N4';
type Rule = { name: string; pattern: RegExp };
type Listed = { file: string; token: string; removedBy: Increment };

const NAME_RULES: readonly Rule[] = [
  { name: 'connectionTargetName', pattern: /connectionTargetName/ },
  { name: 'freeName', pattern: /freeName/ },
  { name: 'DEFAULT_ALIAS', pattern: /DEFAULT_ALIAS/ },
  { name: 'LOCAL_SERVER_VALUES', pattern: /LOCAL_SERVER_VALUES/ },
  { name: 'default as a model name', pattern: /(model|modelAlias|alias)\s*[:=]\s*['"]default['"]/ },
  { name: 'local-${', pattern: /local-\$\{/ },
];

const PORT_RULES: readonly Rule[] = [
  { name: '1234', pattern: /(?<![\w.])1234(?![\w.])/ },
  { name: '11434', pattern: /(?<![\w.])11434(?![\w.])/ },
];

const ADDRESSES_AS_DATA = ['packages/protocol/src/server-kinds.ts', 'packages/protocol/src/local-servers.ts'] as const;

const ALLOWED_UNTIL: readonly Listed[] = [
];

const filesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(full);
    return entry.isFile() ? [full] : [];
  });

const sourceFiles = (): string[] =>
  fs
    .readdirSync(packagesDir)
    .filter((name) => fs.existsSync(path.join(packagesDir, name, 'src')))
    .flatMap((name) => filesUnder(path.join(packagesDir, name, 'src')));

const relative = (file: string): string => path.relative(root, file).split(path.sep).join('/');

const pairsOf = (files: readonly string[], rules: readonly Rule[]): string[] =>
  files
    .flatMap((full) => {
      const text = fs.readFileSync(full, 'utf8');
      return rules.filter((rule) => rule.pattern.test(text)).map((rule) => `${relative(full)}: ${rule.name}`);
    })
    .sort();

const namePairs = (): string[] => pairsOf([...sourceFiles(), ...filesUnder(path.join(root, 'scripts')), path.join(root, 'README.md')], NAME_RULES);

const listedPairs = (): string[] => ALLOWED_UNTIL.map((entry) => `${entry.file}: ${entry.token}`).sort();

describe('no name is made from a model id or a port, and no model is named default (I-N8)', () => {
  it('no source outside the burn-down list holds a name-making function or the literal default as a model name', () => {
    const listed = new Set(listedPairs());
    expect(namePairs().filter((pair) => !listed.has(pair))).toEqual([]);
  });

  it('the ports of the known servers are written only where addresses are data', () => {
    const holders = pairsOf(sourceFiles(), PORT_RULES);
    expect(holders.filter((pair) => !ADDRESSES_AS_DATA.some((file) => pair.startsWith(`${file}: `)))).toEqual([]);
    expect(holders.filter((pair) => pair.startsWith(`${ADDRESSES_AS_DATA[0]}: `))).toEqual([`${ADDRESSES_AS_DATA[0]}: 11434`, `${ADDRESSES_AS_DATA[0]}: 1234`].sort());
  });

  it('the burn-down list holds only files that still contain their token', () => {
    const present = new Set(namePairs());
    expect(listedPairs().filter((pair) => !present.has(pair))).toEqual([]);
  });
});
