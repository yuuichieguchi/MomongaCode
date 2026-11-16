import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { calleeName, childOf, identifierName, lineOf, packageSources, parentsOf, parseSource, parsedProductSource, relativeOf } from './support/source-scan.ts';
import type { ParsedSource, SourceNode } from './support/source-scan.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const CACHE_FACTORY = 'createUserSettingsCache';
const PINNED_DERIVATION = 'createPinnedDerivation';
const LOAD_METHODS = new Set(['load']);

type CacheUse = { readonly where: string; readonly use: string };

const cacheNamesOf = (source: ParsedSource, parents: ReadonlyMap<SourceNode, SourceNode | undefined>): Set<string> =>
  new Set(
    source.nodes
      .filter(({ node }) => node.type === 'CallExpression' && calleeName(node) === CACHE_FACTORY)
      .flatMap(({ node }) => {
        const declarator = parents.get(node);
        const name = declarator?.type === 'VariableDeclarator' ? identifierName(childOf(declarator, 'id')) : undefined;
        return name === undefined ? [] : [name];
      }),
  );

const useOf = (node: SourceNode, parents: ReadonlyMap<SourceNode, SourceNode | undefined>): string => {
  const parent = parents.get(node);
  if (parent?.type === 'MemberExpression' && childOf(parent, 'object') === node) {
    const property = identifierName(childOf(parent, 'property')) ?? '[computed]';
    const call = parents.get(parent);
    return call?.type === 'CallExpression' && childOf(call, 'callee') === parent ? `${property}()` : property;
  }
  if (parent?.type === 'Property' && childOf(parent, 'value') === node) {
    const object = parents.get(parent);
    const call = object === undefined ? undefined : parents.get(object);
    if (call?.type === 'CallExpression' && calleeName(call) === PINNED_DERIVATION) return `${PINNED_DERIVATION} input`;
  }
  return `handed to ${parent?.type ?? 'nothing'}`;
};

const cacheUses = (source: ParsedSource): CacheUse[] => {
  const parents = parentsOf(source);
  const names = cacheNamesOf(source, parents);
  return source.references
    .filter(({ node }) => names.has(identifierName(node) ?? ''))
    .map(({ node }) => ({ where: `${relativeOf(source.file)}:${lineOf(source, node)}`, use: useOf(node, parents) }));
};

const isAllowed = ({ use }: CacheUse): boolean => use === `${PINNED_DERIVATION} input` || [...LOAD_METHODS].some((method) => use === `${method}()`);

const refusedIn = (text: string): string[] =>
  cacheUses(parseSource('sample.ts', text))
    .filter((use) => !isAllowed(use))
    .map(({ use }) => use);

const GATEWAY_SOURCES = packageSources('gateway');

describe('O-R5-6 (K) 5: every read of settings in the gateway process goes through the pinned derivation', () => {
  it('the gateway builds its user settings cache in exactly one place', () => {
    const built = GATEWAY_SOURCES.flatMap((file) => {
      const source = parsedProductSource(file);
      return [...cacheNamesOf(source, parentsOf(source))].map((name) => ({ file: relativeOf(file), name }));
    });
    expect(built).toEqual([{ file: 'packages/gateway/src/process.ts', name: 'cache' }]);
  });

  it('refuses every use of the cache but its load and its hand-over to the pinned derivation: get, read, snapshot, any other member and any other hand-over', () => {
    const header = `const cache = ${CACHE_FACTORY}(options);\n`;
    expect(refusedIn(`${header}await cache.load(signal);\n${PINNED_DERIVATION}({ cache, signal });`)).toEqual([]);
    expect(refusedIn(`${header}const value = cache.get();`)).toEqual(['get()']);
    expect(refusedIn(`${header}const value = cache.read();`)).toEqual(['read()']);
    expect(refusedIn(`${header}const value = cache.snapshot();`)).toEqual(['snapshot()']);
    expect(refusedIn(`${header}const kept = cache.kept;`)).toEqual(['kept']);
    expect(refusedIn(`${header}startOther({ cache });`)).toEqual(['handed to Property']);
  });

  it('nothing in packages/gateway/src uses the user settings cache but to load it and to hand it to the pinned derivation', () => {
    const refused = GATEWAY_SOURCES.flatMap((file) => cacheUses(parsedProductSource(file)).filter((use) => !isAllowed(use)));
    expect(refused).toEqual([]);
  });
});
