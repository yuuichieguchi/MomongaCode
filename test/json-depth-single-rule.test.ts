import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonDepthError, MAX_JSON_DEPTH, checkJsonDepth, parseOutsideJson } from '@momonga/foundation';

const ROOT = path.resolve(import.meta.dirname, '..');

const sourceOf = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts') ? [full] : [];
  });

const productSources = (): string[] =>
  fs
    .readdirSync(path.join(ROOT, 'packages'))
    .filter((name) => name !== 'testkit')
    .map((name) => path.join(ROOT, 'packages', name, 'src'))
    .filter((dir) => fs.existsSync(dir))
    .flatMap(sourceFiles);

const BOUNDARIES = [
  'packages/tools/src/validate.ts',
  'packages/runtime/src/service/request.ts',
  'packages/config/src/json-file.ts',
  'packages/eval/src/dataset.ts',
  'packages/mcp/src/input-requests.ts',
  'packages/mcp/src/connection.ts',
];

const CONSTANT_DECLARATION = /\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*DEPTH[A-Z0-9_]*)\s*=\s*\d/g;

const UNRELATED_TO_JSON = new Set(['MAX_CAUSE_DEPTH']);

const JSON_PARSE_CALL = /\bJSON\.parse\(/g;

const ENTRY_DEFINITION = /export const parseOutsideJson\b/;

type InternalParse = { calls: number; reason: string };

const INTERNAL_PARSES: Readonly<Record<string, InternalParse>> = {
  'packages/store/src/rows.ts': { calls: 1, reason: 'rows the runtime store wrote to its own SQLite database' },
  'packages/store/src/search.ts': { calls: 1, reason: 'a round trip of an event the store already holds, through the redactor' },
  'packages/gateway/src/core/store.ts': { calls: 1, reason: 'records the gateway wrote to its own store' },
  'packages/protocol/src/envelope-grammar.ts': {
    calls: 1,
    reason: 'a payload the gateway minted, parsed in the gateway only after its HMAC verifies and in the runtime only from its own gateway\'s output',
  },
  'packages/gateway/src/probe/record.ts': { calls: 1, reason: 'probe records the product wrote' },
  'packages/gateway/src/probe/endpoint-record.ts': { calls: 1, reason: 'endpoint probe records the product wrote' },
  'packages/cli/src/history-store.ts': { calls: 1, reason: 'the prompt history file the product writes' },
  'packages/cli/src/commands/trace.ts': { calls: 1, reason: 'a span attribute the product encoded' },
  'packages/cli/src/eval/context-host.ts': { calls: 1, reason: 'the eval owner marker the product writes' },
  'packages/cli/src/update/node-ports.ts': { calls: 1, reason: 'the update state file the product writes' },
  'packages/cli/src/client/runtime-client.ts': { calls: 2, reason: 'responses of the product\'s own run service, which bounds its inputs at entry' },
  'packages/cli/src/client/supervisor-client.ts': { calls: 2, reason: 'responses of the product\'s own supervisor' },
  'packages/cli/src/client/gateway-client.ts': { calls: 1, reason: 'responses of the product\'s own gateway, which bounds upstream data at entry' },
  'packages/runtime/src/gateway-client.ts': { calls: 5, reason: 'responses and stream frames of the product\'s own gateway, which bounds upstream data at entry' },
  'packages/observability/src/trace-store.ts': { calls: 1, reason: 'spans the product wrote to its own trace store' },
  'packages/observability/src/cost-report.ts': { calls: 1, reason: 'a span attribute the product encoded' },
  'packages/sandbox/src/placeholder-journal.ts': { calls: 1, reason: 'the placeholder journal the sandbox writes' },
  'packages/foundation/src/process-contract.ts': { calls: 1, reason: 'the ready line of a child process the product started' },
  'packages/supervisor/src/lock-watch.ts': { calls: 1, reason: 'health answers of the product\'s own child services' },
  'packages/verify/src/z3-distribution.ts': { calls: 1, reason: 'the Z3 manifest the product builds and ships' },
  'packages/tools/src/ripgrep-distribution.ts': { calls: 1, reason: 'the ripgrep manifest the product builds and ships' },
  'packages/foundation/src/oauth-provider.ts': { calls: 1, reason: 'the OAuth credential store the product writes' },
  'packages/config/src/auto-fit.ts': {
    calls: 2,
    reason: 'the auto mode dataset the product ships, and the measurement record the product wrote to its own state directory',
  },
  'packages/eval/src/guideline-outcome.ts': { calls: 1, reason: 'a JSON.stringify round trip of a value already in memory' },
};

const parseCallsByFile = (): Record<string, number> =>
  Object.fromEntries(
    productSources()
      .map((file) => [path.relative(ROOT, file), [...fs.readFileSync(file, 'utf8').matchAll(JSON_PARSE_CALL)].length] as const)
      .filter(([, calls]) => calls > 0),
  );

const entryFiles = (): string[] =>
  productSources()
    .filter((file) => ENTRY_DEFINITION.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file));

describe('one JSON depth rule for every value that enters from outside', () => {
  it('walks a value with the one foundation walk and refuses depth past the bound with the typed error', () => {
    let atBound: unknown = [];
    for (let level = 1; level < MAX_JSON_DEPTH; level += 1) atBound = [atBound];
    expect(() => checkJsonDepth(atBound)).not.toThrow();
    expect(() => checkJsonDepth([atBound])).toThrow(JsonDepthError);
  });

  it.each(BOUNDARIES)('%s bounds depth through the one foundation walk or entry', (file) => {
    const source = sourceOf(file);
    const walk = /\b(checkJsonDepth|parseOutsideJson)\(/.exec(source)?.[1];
    expect(walk).toBeDefined();
    if (!file.startsWith('packages/foundation/')) expect(source).toMatch(new RegExp(`import \\{[^}]*\\b${walk}\\b[^}]*\\} from '@momonga/foundation'`));
  });

  it('declares no JSON depth constant other than the one in foundation', () => {
    const declared = productSources().flatMap((file) =>
      [...fs.readFileSync(file, 'utf8').matchAll(CONSTANT_DECLARATION)]
        .map((match) => match[1] as string)
        .filter((name) => !UNRELATED_TO_JSON.has(name))
        .map((name) => `${path.relative(ROOT, file)}:${name}`),
    );
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatch(/^packages\/foundation\/src\/[^:]+:MAX_JSON_DEPTH$/);
  });

  it('parses outside text through one foundation entry that bounds the depth', () => {
    let atBound = '[]';
    for (let level = 1; level < MAX_JSON_DEPTH; level += 1) atBound = `[${atBound}]`;
    expect(JSON.stringify(parseOutsideJson(atBound))).toBe(atBound);
    expect(() => parseOutsideJson(`[${atBound}]`)).toThrow(JsonDepthError);
    expect(() => parseOutsideJson('{"a":')).toThrow(SyntaxError);
    expect(entryFiles()).toHaveLength(1);
    expect(entryFiles()[0]).toMatch(/^packages\/foundation\/src\//);
  });

  it('allows JSON.parse only in the entry and in the listed internal persistence', () => {
    const [entry] = entryFiles();
    const unexpected = Object.entries(parseCallsByFile())
      .filter(([file]) => file !== entry)
      .filter(([file, calls]) => INTERNAL_PARSES[file]?.calls !== calls)
      .map(([file, calls]) => `${file}: ${calls}`);
    expect(unexpected).toEqual([]);
  });

  it('keeps every internal persistence entry current', () => {
    const calls = parseCallsByFile();
    const stale = Object.entries(INTERNAL_PARSES)
      .filter(([file, entry]) => calls[file] !== entry.calls || entry.reason === '')
      .map(([file]) => file);
    expect(stale).toEqual([]);
  });

  it('bounds model output in the constrained sink with the foundation constant', () => {
    const source = sourceOf('packages/gateway/src/adapters/chat-completions/constrained-sink.ts');
    expect(source).toMatch(/import \{[^}]*\bMAX_JSON_DEPTH\b[^}]*\} from '@momonga\/foundation'/);
  });

  it('leaves canonicalJson without a depth limit of its own', () => {
    const source = sourceOf('packages/foundation/src/canonical-json.ts');
    expect(source).not.toMatch(/\bcheckJsonDepth\b/);
    expect(source).not.toMatch(/\bMAX_JSON_DEPTH\b/);
  });
});
