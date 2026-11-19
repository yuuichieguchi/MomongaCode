import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JsonDepthError, MAX_JSON_DEPTH, checkJsonDepth, parseOutsideJson } from '@momonga/foundation';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { ROOT, callsOf, countInto, isMemberCallOf, memberChain, childOf, childrenOf, parseSource, perFile, productSources, relativeOf } from './support/source-scan.ts';
import type { Counts, ParsedSource, SourceNode } from './support/source-scan.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const sourceOf = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const BOUNDARIES = [
  'packages/tools/src/validate.ts',
  'packages/runtime/src/service/request.ts',
  'packages/config/src/json-file.ts',
  'packages/eval/src/dataset.ts',
  'packages/mcp/src/input-requests.ts',
  'packages/mcp/src/connection.ts',
];

const CONSTANT_DECLARATION = /\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*DEPTH[A-Z0-9_]*)\s*=\s*\d/g;

const UNRELATED_TO_JSON = new Set(['MAX_CAUSE_DEPTH', 'MAX_GLOB_BRACE_DEPTH']);

const isJsonParse = (call: SourceNode): boolean => memberChain(childOf(call, 'callee')) === 'JSON.parse';

const isBodyParse = (call: SourceNode): boolean => isMemberCallOf(call, 'json') && childrenOf(call, 'arguments').length === 0;

const countJsonParses = (source: ParsedSource): Counts => {
  const counts: Counts = {};
  for (const call of callsOf(source)) {
    if (call.type !== 'CallExpression') continue;
    if (isJsonParse(call)) countInto(counts, 'JSON.parse');
    else if (isBodyParse(call)) countInto(counts, 'body.json');
  }
  return counts;
};

const parsesIn = (text: string): Counts => countJsonParses(parseSource('sample.ts', text));

const ENTRY_DEFINITION = /export const parseOutsideJson\b/;

type InternalParse = { calls: Counts; reason: string };

const INTERNAL_PARSES: Readonly<Record<string, InternalParse>> = {
  'packages/store/src/rows.ts': { calls: { 'JSON.parse': 1 }, reason: 'rows the runtime store wrote to its own SQLite database' },
  'packages/store/src/search.ts': { calls: { 'JSON.parse': 1 }, reason: 'a round trip of an event the store already holds, through the redactor' },
  'packages/gateway/src/core/store-database.ts': { calls: { 'JSON.parse': 1 }, reason: 'records the gateway store thread wrote to its own SQLite database' },
  'packages/protocol/src/envelope-grammar.ts': {
    calls: { 'JSON.parse': 1 },
    reason: 'a payload the gateway minted, parsed in the gateway only after its HMAC verifies and in the runtime only from its own gateway\'s output',
  },
  'packages/gateway/src/probe/record.ts': { calls: { 'JSON.parse': 1 }, reason: 'probe records the product wrote' },
  'packages/gateway/src/probe/consent.ts': { calls: { 'JSON.parse': 1 }, reason: 'the measurement consents the product wrote' },
  'packages/gateway/src/probe/endpoint-record.ts': { calls: { 'JSON.parse': 1 }, reason: 'endpoint probe records the product wrote' },
  'packages/cli/src/history-store.ts': { calls: { 'JSON.parse': 1 }, reason: 'the prompt history file the product writes' },
  'packages/cli/src/commands/trace.ts': { calls: { 'JSON.parse': 1 }, reason: 'a span attribute the product encoded' },
  'packages/cli/src/eval/context-host.ts': { calls: { 'JSON.parse': 1 }, reason: 'the eval owner marker the product writes' },
  'packages/cli/src/update/state.ts': { calls: { 'JSON.parse': 1 }, reason: 'the update state file the product writes' },
  'packages/cli/src/client/runtime-client.ts': { calls: { 'JSON.parse': 2 }, reason: 'responses of the product\'s own run service, which bounds its inputs at entry' },
  'packages/cli/src/client/supervisor-client.ts': { calls: { 'JSON.parse': 2 }, reason: 'responses of the product\'s own supervisor' },
  'packages/observability/src/billed-calls.ts': { calls: { 'JSON.parse': 1 }, reason: 'a span attribute the product encoded' },
  'packages/observability/src/trace-store.ts': { calls: { 'JSON.parse': 1 }, reason: 'spans the product wrote to its own trace store' },
  'packages/sandbox/src/placeholder-journal.ts': { calls: { 'JSON.parse': 1 }, reason: 'the placeholder journal the sandbox writes' },
  'packages/foundation/src/process-contract.ts': { calls: { 'JSON.parse': 1 }, reason: 'the ready line of a child process the product started' },
  'packages/supervisor/src/lock-watch.ts': { calls: { 'JSON.parse': 1 }, reason: 'health answers of the product\'s own child services' },
  'packages/foundation/src/oauth-provider.ts': { calls: { 'JSON.parse': 1 }, reason: 'the OAuth credential store the product writes' },
  'packages/cli/src/tui/terminal/handover.ts': { calls: { 'JSON.parse': 1 }, reason: 'the terminal state the product hands to its own next process' },
  'packages/cli/src/tui/dismissed-notices.ts': { calls: { 'JSON.parse': 1 }, reason: 'the dismissed notices file the product writes in its state directory' },
  'packages/config/src/auto-fit.ts': { calls: { 'JSON.parse': 1 }, reason: 'the auto mode dataset the product ships' },
  'packages/eval/src/guideline-outcome.ts': { calls: { 'JSON.parse': 1 }, reason: 'a JSON.stringify round trip of a value already in memory' },
  'packages/foundation/src/startup-progress.ts': { calls: { 'JSON.parse': 1 }, reason: 'the progress line a child process the product started writes' },
  'packages/foundation/src/uds.ts': { calls: { 'body.json': 1 }, reason: 'the body of an answer of the product\'s own services over its own socket; owner foundation' },
  'packages/runtime/src/service/service.ts': { calls: { 'body.json': 1 }, reason: 'an answer of the product\'s own service; owner runtime' },
  'packages/tools/src/builtins/file-writer.ts': { calls: { 'JSON.parse': 2 }, reason: 'the request the tool runtime writes to its own file writer child and the answer that child writes back' },
  'packages/runtime/src/process/supervised-gateway.ts': { calls: { 'body.json': 1 }, reason: 'the state answer of the product\'s own gateway; owner runtime' },
};

const parseCallsByFile = (): Record<string, Counts> => perFile(productSources(), countJsonParses);

const entryFiles = (): string[] =>
  productSources()
    .filter((file) => ENTRY_DEFINITION.test(fs.readFileSync(file, 'utf8')))
    .map(relativeOf);

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
        .map((name) => `${relativeOf(file)}:${name}`),
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

  it('counts every parse of JSON text: JSON.parse by any spelling of the global and the json() reader of a body, and not a serializer or a column reader', () => {
    expect(parsesIn('const value = JSON.parse(text);')).toEqual({ 'JSON.parse': 1 });
    expect(parsesIn('const value = globalThis.JSON.parse(text);')).toEqual({ 'JSON.parse': 1 });
    expect(parsesIn('const value = await response.body.json();')).toEqual({ 'body.json': 1 });
    expect(parsesIn('const value = await (await fetch(url)).json();')).toEqual({ 'body.json': 1 });
    expect(parsesIn("const reply = context.json(list);\nconst column = reader.json('payload_json');")).toEqual({});
  });

  it('allows a parse of JSON text only in the entry and in the listed internal persistence', () => {
    const [entry] = entryFiles();
    const unexpected = Object.entries(parseCallsByFile())
      .filter(([file]) => file !== entry)
      .filter(([file, calls]) => JSON.stringify(INTERNAL_PARSES[file]?.calls) !== JSON.stringify(calls))
      .map(([file, calls]) => `${file}: ${JSON.stringify(calls)}`);
    expect(unexpected).toEqual([]);
  });

  it('keeps every internal persistence entry current', () => {
    const calls = parseCallsByFile();
    const stale = Object.entries(INTERNAL_PARSES)
      .filter(([file, entry]) => JSON.stringify(calls[file]) !== JSON.stringify(entry.calls) || entry.reason === '')
      .map(([file]) => file);
    expect(stale).toEqual([]);
  });

  it('bounds model output in the constrained sink with the foundation constant', () => {
    const source = sourceOf('packages/gateway/src/adapters/chat-completions/constrained-sink.ts');
    expect(source).toMatch(/import \{[^}]*\bMAX_JSON_DEPTH\b[^}]*\} from '@momonga\/foundation'/);
  });

  it('has no wrapper that turns outside text deeper than the bound into text without its reason', () => {
    const users = productSources()
      .filter((file) => /\bparseJsonOrText\b/.test(fs.readFileSync(file, 'utf8')))
      .map(relativeOf);
    expect(users).toEqual([]);
  });

  it('leaves canonicalJson without a depth limit of its own', () => {
    const source = sourceOf('packages/foundation/src/canonical-json.ts');
    expect(source).not.toMatch(/\bcheckJsonDepth\b/);
    expect(source).not.toMatch(/\bMAX_JSON_DEPTH\b/);
  });
});
