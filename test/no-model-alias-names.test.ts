import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');

const TOKENS = [
  'modelAlias',
  'model_alias',
  'previousModelAlias',
  'AliasCapabilities',
  'AliasRoomFacts',
  'ModelAlias',
  'aliasRoomVerdict',
  'agentAlias',
  'models.aliases',
  'models.targets',
  "'aliases'",
  'model alias',
  '--alias',
  'alias ${',
  'the alias',
  'an alias',
  'no alias',
  'default alias',
  'aliases',
] as const;

type Token = (typeof TOKENS)[number];
type Increment = 'N1' | 'N2' | 'N3a' | 'N3b' | 'N4';
type Listed = { file: string; tokens: readonly Token[]; removedBy: Increment };

const LEGACY_KEY_TOKENS: readonly Token[] = ['modelAlias', 'previousModelAlias', 'model_alias'];

const LEGACY_KEY_FILES = ['packages/protocol/src/model-ref.ts', 'packages/store/src/schema.ts', 'packages/config/src/settings.ts'] as const;

const PERMANENT_FILES: readonly string[] = LEGACY_KEY_FILES;

const PERMANENT_FOR_COMMAND_AND_PATH_ALIASES: readonly string[] = [
  'packages/verify/src/path-model.ts',
  'scripts/sea-cli.test.ts',
  'scripts/sea-ripgrep.test.ts',
  'scripts/update-sea.test.ts',
  'packages/cli/src/tui/slash.ts',
];

const ALLOWED_UNTIL: readonly Listed[] = [
  { file: 'packages/cli/src/tui/app.tsx', tokens: ['modelAlias', 'aliases'], removedBy: 'N3b' },
  { file: 'packages/cli/src/tui/commands/auth.ts', tokens: ['modelAlias', 'an alias'], removedBy: 'N3b' },
  { file: 'packages/cli/src/tui/commands/auto-mode.ts', tokens: ['modelAlias', 'model alias'], removedBy: 'N3b' },
  { file: 'packages/cli/src/tui/commands/shell-commands.ts', tokens: ['model alias', '--alias', 'aliases'], removedBy: 'N3b' },
  { file: 'packages/cli/src/tui/plan-flows.ts', tokens: ['models.aliases', 'models.targets', 'an alias', 'aliases'], removedBy: 'N3b' },
  { file: 'packages/cli/src/tui/slash.ts', tokens: ['modelAlias', 'model alias'], removedBy: 'N3b' },
];

const filesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(full);
    return entry.isFile() ? [full] : [];
  });

const GENERATED_BUNDLE_SUFFIX = '.generated.ts';

const scannedFiles = (): string[] =>
  [
    ...fs
      .readdirSync(packagesDir)
      .filter((name) => fs.existsSync(path.join(packagesDir, name, 'src')))
      .flatMap((name) => filesUnder(path.join(packagesDir, name, 'src'))),
    ...filesUnder(path.join(root, 'scripts')),
    path.join(root, 'README.md'),
  ].filter((file) => !file.endsWith(GENERATED_BUNDLE_SUFFIX));

const relative = (file: string): string => path.relative(root, file).split(path.sep).join('/');

const PERMANENT_FOR_RETIRED_FORMAT_REASONS: readonly string[] = ['packages/protocol/src/reliability.ts', 'packages/eval/src/transcript.ts'];

const isPermanent = (file: string, token: Token): boolean =>
  PERMANENT_FILES.includes(file) ||
  (token === 'aliases' && PERMANENT_FOR_COMMAND_AND_PATH_ALIASES.includes(file)) ||
  (token === 'an alias' && PERMANENT_FOR_RETIRED_FORMAT_REASONS.includes(file));

const pairOf = (file: string, token: Token): string => `${file}: ${token}`;

const presentPairs = (): string[] =>
  scannedFiles()
    .flatMap((full) => {
      const text = fs.readFileSync(full, 'utf8');
      const file = relative(full);
      return TOKENS.filter((token) => text.includes(token) && !isPermanent(file, token)).map((token) => pairOf(file, token));
    })
    .sort();

const listedPairs = (): string[] => ALLOWED_UNTIL.flatMap((entry) => entry.tokens.map((token) => pairOf(entry.file, token))).sort();

const sourceOf = (file: string): string => {
  const full = path.join(root, file);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
};

describe('no model is called by an alias name any more (I-N9)', () => {
  it('a token of the list appears only in a permanently allowed file or in a file listed for a later increment', () => {
    const listed = new Set(listedPairs());
    expect(presentPairs().filter((pair) => !listed.has(pair))).toEqual([]);
  });

  it('the list holds only files that still contain their token, so it shrinks to empty', () => {
    const present = new Set(presentPairs());
    expect(listedPairs().filter((pair) => !present.has(pair))).toEqual([]);
    expect(listedPairs().length).toBe(new Set(listedPairs()).size);
  });

  it('the keys of an earlier build are named in three files: the decoder, the migration and the old-key sentences (I-N17)', () => {
    expect(['modelAlias', 'previousModelAlias'].filter((key) => !sourceOf('packages/protocol/src/model-ref.ts').includes(key))).toEqual([]);
    expect(sourceOf('packages/config/src/settings.ts')).toContain('models.targets is not a setting any more');
    const holders = scannedFiles()
      .filter((full) => LEGACY_KEY_TOKENS.some((token) => fs.readFileSync(full, 'utf8').includes(token)))
      .map(relative)
      .filter((file) => !(LEGACY_KEY_FILES as readonly string[]).includes(file))
      .sort();
    const listed = ALLOWED_UNTIL.filter((entry) => entry.tokens.some((token) => LEGACY_KEY_TOKENS.includes(token))).map((entry) => entry.file).sort();
    expect(holders).toEqual(listed);
  });
});
