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
  { file: 'packages/cli/src/acp/agent.ts', tokens: ['modelAlias', 'ModelAlias', 'aliases'], removedBy: 'N3a' },
  { file: 'packages/cli/src/acp/events.ts', tokens: ['modelAlias'], removedBy: 'N3a' },
  { file: 'packages/cli/src/acp/models.ts', tokens: ['aliases'], removedBy: 'N3a' },
  { file: 'packages/cli/src/acp/serve.ts', tokens: ['modelAlias'], removedBy: 'N3a' },
  { file: 'packages/cli/src/client/gateway-client.ts', tokens: ['model alias', 'alias ${'], removedBy: 'N3a' },
  { file: 'packages/cli/src/client/golden-run-api.ts', tokens: ['modelAlias'], removedBy: 'N3a' },
  { file: 'packages/cli/src/client/runtime-client.ts', tokens: ['modelAlias', 'ModelAlias'], removedBy: 'N3a' },
  { file: 'packages/cli/src/client/views.ts', tokens: ['modelAlias'], removedBy: 'N3a' },
  { file: 'packages/cli/src/commands/auto-mode.ts', tokens: ['modelAlias', 'agentAlias', 'models.aliases', 'alias ${', 'the alias', 'aliases'], removedBy: 'N3a' },
  { file: 'packages/cli/src/commands/context.ts', tokens: ['AliasCapabilities'], removedBy: 'N3a' },
  { file: 'packages/cli/src/commands/evaluate.ts', tokens: ['model alias', '--alias', 'the alias', 'aliases'], removedBy: 'N3a' },
  { file: 'packages/cli/src/commands/gateway.ts', tokens: ['models.targets'], removedBy: 'N3a' },
  { file: 'packages/cli/src/commands/models.ts', tokens: ['AliasCapabilities', 'models.aliases', 'models.targets', 'model alias', 'alias ${', 'aliases'], removedBy: 'N3a' },
  { file: 'packages/cli/src/commands/register.ts', tokens: ['modelAlias', 'model alias', '--alias', 'an alias', 'aliases'], removedBy: 'N3a' },
  { file: 'packages/cli/src/eval/context-host.ts', tokens: ['modelAlias', 'models.aliases', '--alias', 'alias ${', 'the alias', 'aliases'], removedBy: 'N3a' },
  { file: 'packages/cli/src/program.ts', tokens: ['modelAlias', 'model alias'], removedBy: 'N3a' },
  { file: 'packages/cli/src/readiness.ts', tokens: ['models.aliases', 'models.targets', 'aliases'], removedBy: 'N3a' },
  { file: 'packages/cli/src/run/headless.ts', tokens: ['modelAlias'], removedBy: 'N3a' },
  { file: 'packages/cli/src/run/open-session.ts', tokens: ['modelAlias'], removedBy: 'N3a' },
  { file: 'packages/cli/src/tui/app.tsx', tokens: ['modelAlias', 'AliasCapabilities', 'aliases'], removedBy: 'N3b' },
  { file: 'packages/cli/src/tui/backend.ts', tokens: ['modelAlias', 'ModelAlias'], removedBy: 'N3b' },
  { file: 'packages/cli/src/tui/commands/auth.ts', tokens: ['modelAlias', 'an alias'], removedBy: 'N3b' },
  { file: 'packages/cli/src/tui/commands/auto-mode.ts', tokens: ['modelAlias', 'model alias'], removedBy: 'N3b' },
  { file: 'packages/cli/src/tui/commands/shell-commands.ts', tokens: ['model alias', '--alias', 'aliases'], removedBy: 'N3b' },
  { file: 'packages/cli/src/tui/plan-flows.ts', tokens: ['models.aliases', 'models.targets', 'an alias', 'aliases'], removedBy: 'N3b' },
  { file: 'packages/cli/src/tui/slash.ts', tokens: ['modelAlias', 'model alias'], removedBy: 'N3b' },
  { file: 'packages/context/src/budget.ts', tokens: ['AliasCapabilities'], removedBy: 'N2' },
  { file: 'packages/eval/src/auto-gate-record.ts', tokens: ['agentAlias'], removedBy: 'N4' },
  { file: 'packages/eval/src/context-improve.ts', tokens: ['alias ${', 'the alias'], removedBy: 'N4' },
  { file: 'packages/eval/src/context-live.ts', tokens: ['modelAlias'], removedBy: 'N4' },
  { file: 'packages/eval/src/context-report.ts', tokens: ['modelAlias', '--alias', 'the alias', 'aliases'], removedBy: 'N4' },
  { file: 'packages/eval/src/runner.ts', tokens: ['modelAlias'], removedBy: 'N4' },
  { file: 'packages/eval/src/transcript.ts', tokens: ['modelAlias'], removedBy: 'N4' },
  { file: 'packages/gateway/src/adapters/chat-completions/types.ts', tokens: ['AliasRoomFacts'], removedBy: 'N1' },
  { file: 'packages/gateway/src/core/router.ts', tokens: ['AliasCapabilities', 'aliasRoomVerdict', 'models.aliases', 'models.targets', 'model alias', 'the alias', 'aliases'], removedBy: 'N1' },
  { file: 'packages/gateway/src/core/unary.ts', tokens: ['model alias'], removedBy: 'N1' },
  { file: 'packages/gateway/src/core/unknown-fields.ts', tokens: ['model alias'], removedBy: 'N1' },
  { file: 'packages/gateway/src/core/validation.ts', tokens: ['the alias'], removedBy: 'N1' },
  { file: 'packages/gateway/src/managed/target.ts', tokens: ['AliasRoomFacts'], removedBy: 'N1' },
  { file: 'packages/gateway/src/process.ts', tokens: ['models.aliases', 'models.targets', 'aliases'], removedBy: 'N1' },
  { file: 'packages/gateway/src/server/app.ts', tokens: ['aliases'], removedBy: 'N1' },
  { file: 'packages/gateway/src/server/capability-listing.ts', tokens: ['AliasCapabilities', 'model alias'], removedBy: 'N1' },
  { file: 'packages/gateway/src/server/config-check.ts', tokens: ['models.aliases', 'models.targets', 'aliases'], removedBy: 'N1' },
  { file: 'packages/gateway/src/server/gateway.ts', tokens: ['models.targets'], removedBy: 'N1' },
  { file: 'packages/gateway/src/types.ts', tokens: ['aliases'], removedBy: 'N1' },
  { file: 'packages/reliability/src/aggregate.ts', tokens: ['modelAlias'], removedBy: 'N2' },
  { file: 'packages/reliability/src/fold-facts.ts', tokens: ['modelAlias'], removedBy: 'N2' },
  { file: 'packages/reliability/src/types.ts', tokens: ['modelAlias'], removedBy: 'N2' },
  { file: 'packages/runtime/src/memory/journal-thread-code.generated.ts', tokens: ['modelAlias', 'model_alias', 'previousModelAlias', 'ModelAlias'], removedBy: 'N2' },
  { file: 'packages/runtime/src/memory/journal-thread.ts', tokens: ['modelAlias'], removedBy: 'N2' },
  { file: 'packages/runtime/src/memory/reflection.ts', tokens: ['modelAlias'], removedBy: 'N2' },
  { file: 'packages/runtime/src/process/child-runs.ts', tokens: ['modelAlias', 'model alias', 'aliases'], removedBy: 'N2' },
  { file: 'packages/runtime/src/process/defaults.ts', tokens: ['modelAlias'], removedBy: 'N2' },
  { file: 'packages/runtime/src/process/settings-port.ts', tokens: ['models.aliases', 'models.targets', 'aliases'], removedBy: 'N2' },
  { file: 'packages/runtime/src/process/start-runtime-process.ts', tokens: ['modelAlias'], removedBy: 'N2' },
  { file: 'packages/runtime/src/service/app.ts', tokens: ['modelAlias', 'ModelAlias', 'model alias', 'alias ${', 'aliases'], removedBy: 'N2' },
  { file: 'packages/runtime/src/service/errors.ts', tokens: ['model alias', 'alias ${'], removedBy: 'N2' },
  { file: 'packages/runtime/src/service/request.ts', tokens: ['modelAlias'], removedBy: 'N2' },
  { file: 'packages/runtime/src/service/rules.ts', tokens: ['modelAlias', 'model alias', 'alias ${'], removedBy: 'N2' },
  { file: 'packages/runtime/src/service/service.ts', tokens: ['modelAlias'], removedBy: 'N2' },
  { file: 'packages/runtime/src/service/views.ts', tokens: ['modelAlias'], removedBy: 'N2' },
  { file: 'packages/runtime/src/worker/claim-runner.ts', tokens: ['modelAlias', 'model alias'], removedBy: 'N2' },
  { file: 'packages/runtime/src/worker/context-step.ts', tokens: ['alias ${'], removedBy: 'N2' },
  { file: 'packages/runtime/src/worker/model-switch.ts', tokens: ['modelAlias', 'previousModelAlias', 'ModelAlias'], removedBy: 'N2' },
  { file: 'packages/runtime/src/worker/pins.ts', tokens: ['modelAlias', 'model alias'], removedBy: 'N2' },
  { file: 'packages/store/src/codec.ts', tokens: ['modelAlias', 'model_alias', 'previousModelAlias', 'ModelAlias'], removedBy: 'N2' },
  { file: 'packages/store/src/index.ts', tokens: ['ModelAlias'], removedBy: 'N2' },
  { file: 'packages/store/src/run-facts.ts', tokens: ['modelAlias', 'model_alias'], removedBy: 'N2' },
  { file: 'packages/store/src/runtime-store.ts', tokens: ['modelAlias', 'model_alias', 'previousModelAlias', 'ModelAlias'], removedBy: 'N2' },
  { file: 'packages/store/src/types.ts', tokens: ['modelAlias', 'ModelAlias'], removedBy: 'N2' },
  { file: 'scripts/plan-real-check.ts', tokens: ["'aliases'", '--alias', 'alias ${', 'the alias', 'aliases'], removedBy: 'N4' },
  { file: 'README.md', tokens: ['models.aliases', 'models.targets', 'model alias', 'the alias', 'an alias', 'aliases'], removedBy: 'N4' },
];

const filesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(full);
    return entry.isFile() ? [full] : [];
  });

const scannedFiles = (): string[] => [
  ...fs
    .readdirSync(packagesDir)
    .filter((name) => fs.existsSync(path.join(packagesDir, name, 'src')))
    .flatMap((name) => filesUnder(path.join(packagesDir, name, 'src'))),
  ...filesUnder(path.join(root, 'scripts')),
  path.join(root, 'README.md'),
];

const relative = (file: string): string => path.relative(root, file).split(path.sep).join('/');

const isPermanent = (file: string, token: Token): boolean => PERMANENT_FILES.includes(file) || (token === 'aliases' && PERMANENT_FOR_COMMAND_AND_PATH_ALIASES.includes(file));

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
