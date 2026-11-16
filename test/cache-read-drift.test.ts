import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CACHE_READ_TEXT } from '@momonga/observability';
import { CACHE_READS_NOT_REPORTED, UNPRICED_CODE_TEXT } from '@momonga/protocol';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { ROOT, childOf, identifierName, literalValue, memberChain, packageSources, parseSource, parsedProductSource, relativeOf, sourcesUnder, unwrapped, workspacePackages } from './support/source-scan.ts';
import type { ParsedSource, SourceNode } from './support/source-scan.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = ROOT;

const sourcesOf = (relative: string): string[] => sourcesUnder(path.join(root, relative)).map(relativeOf);

const ALL_SOURCES = workspacePackages().flatMap(packageSources).map(relativeOf);

const SURFACE_SOURCES = ['packages/observability/src', 'packages/eval/src', 'packages/cli/src'].flatMap(sourcesOf);

const FIELD = 'cachedInputTokens';
const EQUALITY = new Set(['===', '!==', '==', '!=']);

const isUndefined = (node: SourceNode | undefined): boolean => {
  const plain = unwrapped(node);
  if (identifierName(plain) === 'undefined') return true;
  if (plain?.type === 'UnaryExpression' && plain['operator'] === 'void') return true;
  return literalValue(plain) === 'undefined';
};

const isField = (node: SourceNode | undefined): boolean => {
  const plain = unwrapped(node);
  if (plain?.type === 'UnaryExpression' && plain['operator'] === 'typeof') return isField(childOf(plain, 'argument'));
  const chain = memberChain(plain?.type === 'ChainExpression' ? childOf(plain, 'expression') : plain);
  return chain === FIELD || chain?.endsWith(`.${FIELD}`) === true;
};

const decidesCacheReport = (source: ParsedSource): boolean =>
  source.nodes.some(({ node }) => {
    if (node.type !== 'BinaryExpression' || !EQUALITY.has(String(node['operator']))) return false;
    const left = childOf(node, 'left');
    const right = childOf(node, 'right');
    return (isField(left) && isUndefined(right)) || (isField(right) && isUndefined(left));
  });

const decidesIn = (text: string): boolean => decidesCacheReport(parseSource('sample.ts', text));

const filesMatching = (files: readonly string[], pattern: RegExp): string[] =>
  files.filter((file) => pattern.test(fs.readFileSync(path.join(root, file), 'utf8')));

const WIRE_CACHED_READ = /input_tokens_details\??\.cached_tokens/;

const READERS_OF_THE_WIRE_COUNT = new Set(['packages/protocol/src/open-responses.ts', 'packages/gateway/src/core/model-cost.ts', 'packages/gateway/src/core/attempt-span.ts']);

describe('one reader of whether a call reported its cache reads', () => {
  it('reads input_tokens_details.cached_tokens only in the adapters, the protocol reader and the gateway forwarders', () => {
    const readers = filesMatching(ALL_SOURCES, WIRE_CACHED_READ).filter(
      (file) => !file.startsWith('packages/gateway/src/adapters/') && !READERS_OF_THE_WIRE_COUNT.has(file),
    );

    expect(readers).toEqual([]);
  });

  it('counts a comparison of the field itself with undefined by any spelling, and not a longer name that ends in the field', () => {
    expect(decidesIn('const known = usage.cachedInputTokens !== undefined;')).toBe(true);
    expect(decidesIn('const known = undefined !== usage?.cachedInputTokens;')).toBe(true);
    expect(decidesIn('const known = cachedInputTokens == undefined;')).toBe(true);
    expect(decidesIn("const known = typeof usage.cachedInputTokens === 'undefined';")).toBe(true);
    expect(decidesIn('const known = usage.reportedCachedInputTokens !== undefined;\nconst other = notcachedInputTokens === undefined;')).toBe(false);
  });

  it('decides the fact with cachedInputTokens === undefined only in billed-calls.ts, cache-reads.ts and token-metrics.ts', () => {
    const deciders = SURFACE_SOURCES.filter((file) => decidesCacheReport(parsedProductSource(path.join(root, file)))).filter((file) => file !== 'packages/observability/src/spans.ts');

    expect([...deciders].sort()).toEqual(['packages/eval/src/token-metrics.ts', 'packages/observability/src/billed-calls.ts', 'packages/observability/src/cache-reads.ts']);
  });

  it('reads the cache-read span attribute only in billed-calls.ts, besides the span writer and the attribute names', () => {
    const readers = filesMatching(SURFACE_SOURCES, /ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS/);

    expect(readers).toEqual(['packages/observability/src/billed-calls.ts', 'packages/observability/src/semconv.ts', 'packages/observability/src/spans.ts']);
  });
});

describe('one table of the cache-read texts', () => {
  it('lives in observability/src/cache-reads.ts', () => {
    expect(fs.existsSync(path.join(root, 'packages/observability/src/cache-reads.ts'))).toBe(true);
    expect(typeof CACHE_READ_TEXT).toBe('object');
  });

  it('keeps the cache-read wording of the observability and cli surfaces in that table only', () => {
    const owners = filesMatching(
      ['packages/observability/src', 'packages/cli/src'].flatMap(sourcesOf),
      /cache reads not reported|did not report cache reads|cached not reported|cache split/,
    );

    expect(owners).toEqual(['packages/observability/src/cache-reads.ts']);
  });

  it('holds the phrase cache reads not reported once, as the protocol constant that the code table and every surface read', () => {
    expect(CACHE_READS_NOT_REPORTED).toBe('cache reads not reported');
    expect(UNPRICED_CODE_TEXT.cache_read_not_reported).toBe(CACHE_READS_NOT_REPORTED);
    expect(filesMatching(ALL_SOURCES, /cache reads not reported/)).toEqual(['packages/protocol/src/token-anatomy.ts']);
    expect([...filesMatching(SURFACE_SOURCES, /\bCACHE_READS_NOT_REPORTED\b/)].sort()).toEqual(['packages/eval/src/context-report.ts', 'packages/observability/src/cache-reads.ts']);
    for (const user of ['packages/eval/src/context-report.ts', 'packages/observability/src/cache-reads.ts']) {
      expect(fs.readFileSync(path.join(root, user), 'utf8')).toMatch(/import \{[^}]*\bCACHE_READS_NOT_REPORTED\b[^}]*\} from '@momonga\/protocol'/);
    }
  });
});
