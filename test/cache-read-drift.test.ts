import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CACHE_READ_TEXT } from '@momonga/observability';

const root = path.resolve(import.meta.dirname, '..');

const sourcesUnder = (relative: string): string[] => {
  const directory = path.join(root, relative);
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
};

const ALL_SOURCES = fs
  .readdirSync(path.join(root, 'packages'))
  .filter((name) => fs.existsSync(path.join(root, 'packages', name, 'src')))
  .flatMap((name) => sourcesUnder(path.join('packages', name, 'src')));

const SURFACE_SOURCES = ['packages/observability/src', 'packages/eval/src', 'packages/cli/src'].flatMap(sourcesUnder);

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

  it('decides the fact with cachedInputTokens === undefined only in billed-calls.ts, cache-reads.ts and token-metrics.ts', () => {
    const deciders = filesMatching(SURFACE_SOURCES, /cachedInputTokens\s*[!=]==\s*undefined/).filter((file) => file !== 'packages/observability/src/spans.ts');

    expect(deciders).toEqual(['packages/eval/src/token-metrics.ts', 'packages/observability/src/billed-calls.ts', 'packages/observability/src/cache-reads.ts']);
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
      ['packages/observability/src', 'packages/cli/src'].flatMap(sourcesUnder),
      /cache reads not reported|did not report cache reads|cached not reported|cache split/,
    );

    expect(owners).toEqual(['packages/observability/src/cache-reads.ts']);
  });

  it('keeps the eval wording of the cache-read causes in one eval source', () => {
    expect(filesMatching(sourcesUnder('packages/eval/src'), /cache reads not reported/)).toHaveLength(1);
  });
});
