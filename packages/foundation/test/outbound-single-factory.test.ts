import fs from 'node:fs';
import path from 'node:path';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

const packagesDir = path.resolve(import.meta.dirname, '..', '..');

const FACTORY = 'foundation/src/outbound.ts';

const SANCTIONED: readonly Kept[] = [{ file: 'observability/src/otlp-agent.ts', reason: 'the node:http agent of the OTLP exporter, built from outboundPlan (design N5)' }];

type Kept = { file: string; reason: string };
type BurnDown = { file: string; owner: string };

const KEPT: readonly Kept[] = [{ file: 'foundation/src/uds.ts', reason: 'a Unix-socket client to the local daemon, never a network request' }];

const EXCLUDED_PACKAGES: readonly Kept[] = [{ file: 'testkit', reason: 'test support that drives fake servers on loopback; never shipped' }];

const BURN_DOWN: readonly BurnDown[] = [
  { file: 'mcp/src/remote-policy.ts', owner: 'N3' },
];

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

type Use = 'call' | 'construct';

type ClientModule = { module: string; reason: string; calls: readonly string[]; constructs: readonly string[] };

const CLIENT_MODULES: readonly ClientModule[] = [
  { module: 'node:http', reason: 'its Agent opens TCP connections to any host', calls: [], constructs: ['Agent'] },
  { module: 'http', reason: 'its Agent opens TCP connections to any host', calls: [], constructs: ['Agent'] },
  { module: 'node:https', reason: 'its Agent opens TLS connections to any host', calls: [], constructs: ['Agent'] },
  { module: 'https', reason: 'its Agent opens TLS connections to any host', calls: [], constructs: ['Agent'] },
  {
    module: 'undici',
    reason: 'its fetch sends requests and its dispatchers open connections to any host',
    calls: ['fetch'],
    constructs: ['Agent', 'ProxyAgent', 'EnvHttpProxyAgent', 'Socks5ProxyAgent', 'Pool', 'Client', 'BalancedPool', 'RetryAgent', 'Dispatcher'],
  },
  { module: 'https-proxy-agent', reason: 'its agent tunnels connections through a proxy', calls: [], constructs: ['HttpsProxyAgent'] },
  { module: 'http-proxy-agent', reason: 'its agent sends requests through a proxy', calls: [], constructs: ['HttpProxyAgent'] },
  { module: 'socks-proxy-agent', reason: 'its agent opens connections through a SOCKS proxy', calls: [], constructs: ['SocksProxyAgent'] },
  { module: 'proxy-agent', reason: 'its agent opens connections through the proxy the environment names', calls: [], constructs: ['ProxyAgent'] },
];

type AstNode = { type: string; start: number; [key: string]: unknown };

type Ref =
  | { kind: 'none' }
  | { kind: 'globalThis' }
  | { kind: 'globalFetch' }
  | { kind: 'module'; module: string }
  | { kind: 'export'; module: string; name: string };

type Binding = { kind: 'import'; ref: Ref } | { kind: 'local' } | { kind: 'value'; init: AstNode; path: readonly string[]; scope: Scope };

type Scope = { bindings: Map<string, Binding>; parent: Scope | undefined };

const NONE: Ref = { kind: 'none' };

const isNode = (value: unknown): value is AstNode =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string' && typeof (value as { start?: unknown }).start === 'number';

const child = (node: AstNode, key: string): AstNode | undefined => {
  const value = node[key];
  return isNode(value) ? value : undefined;
};

const children = (node: AstNode, key: string): AstNode[] => {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
};

const nameOf = (node: AstNode | undefined): string | undefined => {
  if (node === undefined) return undefined;
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return undefined;
};

const clientModule = (module: string): ClientModule | undefined => CLIENT_MODULES.find((entry) => entry.module === module);

const memberOf = (ref: Ref, name: string): Ref => {
  if (ref.kind === 'globalThis') return name === 'fetch' ? { kind: 'globalFetch' } : NONE;
  if (ref.kind === 'module') return { kind: 'export', module: ref.module, name };
  return NONE;
};

const isClient = (ref: Ref, use: Use): boolean => {
  if (ref.kind === 'globalFetch') return use === 'call';
  if (ref.kind !== 'export') return false;
  const entry = clientModule(ref.module);
  if (entry === undefined) return false;
  return (use === 'call' ? entry.calls : entry.constructs).includes(ref.name);
};

const lookup = (scope: Scope | undefined, name: string): Binding | undefined => {
  for (let current = scope; current !== undefined; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding !== undefined) return binding;
  }
  return undefined;
};

const resolveBinding = (binding: Binding, visiting: Set<Binding>): Ref => {
  if (binding.kind === 'import') return binding.ref;
  if (binding.kind === 'local' || visiting.has(binding)) return NONE;
  visiting.add(binding);
  const base = resolveIn(binding.init, binding.scope, visiting);
  const ref = binding.path.reduce(memberOf, base);
  visiting.delete(binding);
  return ref;
};

const resolveIn = (node: AstNode, scope: Scope, visiting: Set<Binding>): Ref => {
  if (node.type === 'Identifier' && typeof node.name === 'string') {
    const binding = lookup(scope, node.name);
    if (binding !== undefined) return resolveBinding(binding, visiting);
    if (node.name === 'fetch') return { kind: 'globalFetch' };
    if (node.name === 'globalThis') return { kind: 'globalThis' };
    return NONE;
  }
  if (node.type === 'MemberExpression' || node.type === 'TSQualifiedName') {
    const object = child(node, node.type === 'MemberExpression' ? 'object' : 'left');
    const property = child(node, node.type === 'MemberExpression' ? 'property' : 'right');
    const computed = node.computed === true && property?.type !== 'Literal';
    const name = computed ? undefined : nameOf(property);
    if (object === undefined || name === undefined) return NONE;
    return memberOf(resolveIn(object, scope, visiting), name);
  }
  if (node.type === 'ParenthesizedExpression' || node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression') {
    const inner = child(node, 'expression');
    return inner === undefined ? NONE : resolveIn(inner, scope, visiting);
  }
  return NONE;
};

const bindPattern = (pattern: AstNode | undefined, scope: Scope, init: AstNode | undefined, path: readonly string[]): void => {
  if (pattern === undefined) return;
  if (pattern.type === 'Identifier' && typeof pattern.name === 'string') {
    scope.bindings.set(pattern.name, init === undefined ? { kind: 'local' } : { kind: 'value', init, path, scope });
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of children(pattern, 'properties')) {
      if (property.type === 'RestElement') {
        bindPattern(child(property, 'argument'), scope, undefined, path);
        continue;
      }
      const key = property.computed === true ? undefined : nameOf(child(property, 'key'));
      bindPattern(child(property, 'value'), scope, key === undefined ? undefined : init, [...path, key ?? '']);
    }
    return;
  }
  if (pattern.type === 'AssignmentPattern') return bindPattern(child(pattern, 'left'), scope, init, path);
  if (pattern.type === 'RestElement') return bindPattern(child(pattern, 'argument'), scope, undefined, path);
  if (pattern.type === 'ArrayPattern') for (const element of children(pattern, 'elements')) bindPattern(element, scope, undefined, path);
  if (pattern.type === 'TSParameterProperty') bindPattern(child(pattern, 'parameter'), scope, undefined, path);
};

const FUNCTIONS: ReadonlySet<string> = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

const importRef = (specifier: AstNode, module: string): Ref => {
  if (specifier.type === 'ImportSpecifier') {
    const imported = nameOf(child(specifier, 'imported'));
    return imported === undefined ? NONE : { kind: 'export', module, name: imported };
  }
  return { kind: 'module', module };
};

const declareStatement = (statement: AstNode, scope: Scope, functionScope: Scope): void => {
  const declaration = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? child(statement, 'declaration') : statement;
  if (declaration === undefined) return;
  if (declaration.type === 'ImportDeclaration') {
    const module = nameOf(child(declaration, 'source'));
    if (module === undefined) return;
    for (const specifier of children(declaration, 'specifiers')) {
      const local = nameOf(child(specifier, 'local'));
      if (local !== undefined) scope.bindings.set(local, { kind: 'import', ref: importRef(specifier, module) });
    }
    return;
  }
  if (declaration.type === 'TSImportEqualsDeclaration') {
    const local = nameOf(child(declaration, 'id'));
    const reference = child(declaration, 'moduleReference');
    const module = reference?.type === 'TSExternalModuleReference' ? nameOf(child(reference, 'expression')) : undefined;
    if (local !== undefined) scope.bindings.set(local, module === undefined ? { kind: 'local' } : { kind: 'import', ref: { kind: 'module', module } });
    return;
  }
  if (declaration.type === 'VariableDeclaration') {
    const target = declaration.kind === 'var' ? functionScope : scope;
    for (const declarator of children(declaration, 'declarations')) bindPattern(child(declarator, 'id'), target, child(declarator, 'init'), []);
    return;
  }
  const local = nameOf(child(declaration, 'id'));
  if (local !== undefined && /Declaration$/.test(declaration.type)) scope.bindings.set(local, { kind: 'local' });
};

const hoistVars = (node: AstNode, functionScope: Scope): void => {
  for (const value of Object.values(node)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!isNode(item) || FUNCTIONS.has(item.type)) continue;
      if (item.type === 'VariableDeclaration' && item.kind === 'var') declareStatement(item, functionScope, functionScope);
      hoistVars(item, functionScope);
    }
  }
};

const USE_SITES: Readonly<Record<string, { key: string; use: Use }>> = {
  CallExpression: { key: 'callee', use: 'call' },
  NewExpression: { key: 'callee', use: 'construct' },
  ClassDeclaration: { key: 'superClass', use: 'construct' },
  ClassExpression: { key: 'superClass', use: 'construct' },
  TSTypeQuery: { key: 'exprName', use: 'construct' },
};

const clientsInModule = (source: string, lang: 'ts' | 'tsx'): string[] => {
  const program: unknown = parseAst(source, { lang }, `module.${lang}`);
  if (!isNode(program)) throw new Error('the parser returned no program');
  const lineStarts = [0, ...[...source.matchAll(/\n/g)].map((match) => match.index + 1)];
  const lineAt = (offset: number): string => {
    const index = lineStarts.findLastIndex((start) => start <= offset);
    return source.slice(lineStarts[index], lineStarts[index + 1] ?? source.length).trim();
  };
  const found = new Set<string>();

  const openScope = (parent: Scope | undefined, statements: readonly AstNode[], functionScope?: Scope): Scope => {
    const scope: Scope = { bindings: new Map(), parent };
    for (const statement of statements) declareStatement(statement, scope, functionScope ?? scope);
    return scope;
  };

  const visit = (node: AstNode, scope: Scope, functionScope: Scope): void => {
    const site = USE_SITES[node.type];
    const target = site === undefined ? undefined : child(node, site.key);
    if (site !== undefined && target !== undefined && isClient(resolveIn(target, scope, new Set()), site.use)) found.add(lineAt(target.start));

    if (FUNCTIONS.has(node.type)) {
      const inner: Scope = { bindings: new Map(), parent: scope };
      const name = nameOf(child(node, 'id'));
      if (name !== undefined && node.type === 'FunctionExpression') inner.bindings.set(name, { kind: 'local' });
      for (const param of children(node, 'params')) bindPattern(param, inner, undefined, []);
      for (const [key, value] of Object.entries(node)) if (key !== 'body') for (const item of Array.isArray(value) ? value : [value]) if (isNode(item)) visit(item, inner, inner);
      const body = child(node, 'body');
      if (body === undefined) return;
      hoistVars(body, inner);
      if (body.type === 'BlockStatement') {
        const block = openScope(inner, children(body, 'body'), inner);
        for (const statement of children(body, 'body')) visit(statement, block, inner);
      } else visit(body, inner, inner);
      return;
    }
    if (node.type === 'BlockStatement' || node.type === 'StaticBlock' || node.type === 'TSModuleBlock') {
      const block = openScope(scope, children(node, 'body'), functionScope);
      for (const statement of children(node, 'body')) visit(statement, block, functionScope);
      return;
    }
    if (node.type === 'CatchClause') {
      const inner: Scope = { bindings: new Map(), parent: scope };
      bindPattern(child(node, 'param'), inner, undefined, []);
      const body = child(node, 'body');
      if (body !== undefined) visit(body, inner, functionScope);
      return;
    }
    if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      const head = child(node, node.type === 'ForStatement' ? 'init' : 'left');
      const inner = openScope(scope, head === undefined ? [] : [head], functionScope);
      for (const value of Object.values(node)) for (const item of Array.isArray(value) ? value : [value]) if (isNode(item)) visit(item, inner, functionScope);
      return;
    }
    if (node.type === 'ClassExpression') {
      const inner: Scope = { bindings: new Map(), parent: scope };
      const name = nameOf(child(node, 'id'));
      if (name !== undefined) inner.bindings.set(name, { kind: 'local' });
      for (const [key, value] of Object.entries(node)) for (const item of Array.isArray(value) ? value : [value]) if (isNode(item)) visit(item, key === 'superClass' ? scope : inner, functionScope);
      return;
    }
    for (const value of Object.values(node)) for (const item of Array.isArray(value) ? value : [value]) if (isNode(item)) visit(item, scope, functionScope);
  };

  const top = openScope(undefined, children(program, 'body'));
  hoistVars(program, top);
  for (const statement of children(program, 'body')) visit(statement, top, top);
  return [...found];
};

const clientsInSource = (source: string): string[] => clientsInModule(source, 'ts');

const scanTree = (): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  const excluded = new Set(EXCLUDED_PACKAGES.map((entry) => entry.file));
  for (const pkg of fs.readdirSync(packagesDir)) {
    const src = path.join(packagesDir, pkg, 'src');
    if (excluded.has(pkg) || !fs.existsSync(src)) continue;
    for (const file of sourceFiles(src)) {
      const lines = clientsInModule(fs.readFileSync(file, 'utf8'), file.endsWith('.tsx') ? 'tsx' : 'ts');
      if (lines.length > 0) found.set(path.relative(packagesDir, file).split(path.sep).join('/'), lines);
    }
  }
  return found;
};

let scanned: Map<string, string[]> | undefined;

const offenders = (): Map<string, string[]> => {
  scanned ??= scanTree();
  return scanned;
};

const ALLOWED: ReadonlySet<string> = new Set([FACTORY, ...SANCTIONED.map((entry) => entry.file), ...KEPT.map((entry) => entry.file), ...BURN_DOWN.map((entry) => entry.file)]);

const outsideAllowed = (found: ReadonlyMap<string, readonly string[]>): string[] =>
  [...found].filter(([file]) => !ALLOWED.has(file)).map(([file, lines]) => `${file}: ${lines.map((line) => line.trim()).join(' | ')}`);

describe('every outbound HTTP client comes from the one factory', () => {
  const found = offenders();

  it('no source file outside the factory builds an outbound client or calls fetch', () => {
    expect(outsideAllowed(found)).toEqual([]);
  });

  it('the factory module is where the agents are built', () => {
    expect(found.has(FACTORY)).toBe(true);
  });

  it('every kept and burn-down entry still holds a client, so a stale entry cannot hide a new one', () => {
    const stale = [...SANCTIONED, ...KEPT, ...BURN_DOWN].map((entry) => entry.file).filter((file) => !found.has(file));
    expect(stale).toEqual([]);
  });
});

type Construction = { imports: string; line: string };

const CONSTRUCTIONS: readonly Construction[] = [
  { imports: "import { Agent } from 'undici';", line: 'const agent = new Agent({ keepAlive: true });' },
  { imports: "import http from 'node:http';", line: 'const agent = new http.Agent({ keepAlive: true });' },
  { imports: "import https from 'node:https';", line: 'const agent = new https.Agent({ keepAlive: true });' },
  { imports: "import { HttpsProxyAgent } from 'https-proxy-agent';", line: 'const agent = new HttpsProxyAgent(proxyUrl);' },
  { imports: "import { ProxyAgent } from 'undici';", line: 'const proxy = new ProxyAgent({ uri });' },
  { imports: "import { Pool } from 'undici';", line: 'const pool = new Pool(origin, options);' },
  { imports: "import { HttpsProxyAgent } from 'https-proxy-agent';", line: 'class Routed extends HttpsProxyAgent<string> {}' },
  { imports: "import http from 'node:http';", line: 'class Direct extends http.Agent {}' },
  { imports: "import https from 'node:https';", line: 'class Secure extends https.Agent {}' },
  { imports: "import { Agent } from 'undici';", line: 'class Undici extends Agent {}' },
  { imports: "import { ProxyAgent } from 'undici';", line: 'class Tunnel extends ProxyAgent {}' },
  { imports: "import { Dispatcher } from 'undici';", line: 'class Outbound extends Dispatcher {}' },
  { imports: "import http from 'node:http';", line: 'const build = (base: typeof http.Agent): http.Agent => new (class extends base {})();' },
  { imports: "import https from 'node:https';", line: 'const build = (base: typeof https.Agent): https.Agent => new (class extends base {})();' },
  { imports: '', line: 'const response = await fetch(url);' },
  { imports: '', line: 'const response = await globalThis.fetch(url);' },
  { imports: "import { fetch } from 'undici';", line: 'const response = await fetch(url);' },
  { imports: "import { fetch as get } from 'undici';", line: 'const response = await get(url);' },
  { imports: "import * as undici from 'undici';", line: 'const response = await undici.fetch(url);' },
  { imports: "import { Agent as A } from 'undici';", line: 'const agent = new A({ keepAlive: true });' },
  { imports: "import * as u from 'undici';", line: 'const pool = new u.Pool(origin, options);' },
  { imports: "import * as u from 'undici';", line: 'class Outbound extends u.Dispatcher {}' },
  { imports: "import { Pool as P } from 'undici';", line: 'class Pooled extends P {}' },
  { imports: "import { HttpsProxyAgent as Tunnel } from 'https-proxy-agent';", line: 'class Routed extends Tunnel<string> {}' },
  { imports: "import { HttpProxyAgent } from 'http-proxy-agent';", line: 'const agent = new HttpProxyAgent(proxyUrl);' },
  { imports: "import { Agent } from 'https';", line: 'const agent = new Agent({ keepAlive: true });' },
  { imports: "import { Agent as Plain } from 'http';", line: 'const agent = new Plain({ keepAlive: true });' },
  { imports: "import * as h from 'node:https';", line: 'const agent = new h.Agent({ keepAlive: true });' },
];

const sourceOf = (construction: Construction): string => [construction.imports, construction.line].filter((part) => part !== '').join('\n');

const ALIASED_GLOBAL_FETCH: readonly { source: string; call: string }[] = [
  { source: 'const f = fetch;\nconst response = await f(url);', call: 'const response = await f(url);' },
  { source: 'const { fetch: get } = globalThis;\nconst response = await get(url);', call: 'const response = await get(url);' },
  { source: 'const get = globalThis.fetch;\nconst response = await get(url);', call: 'const response = await get(url);' },
];

const LOCAL_NAMES: readonly string[] = [
  'const fillPage = (after: number, fetch: (after: number, limit: number) => Row[]): Row[] => {\n  const rows = fetch(cursor, wanted);\n  return rows;\n};',
  'function page(fetch: (key: string) => Row) {\n  return fetch(key);\n}',
  'const fetch = (key: string): Row => rows[key];\nconst row = fetch(key);',
  'function fetch(key: string): Row {\n  return rows[key];\n}\nconst row = fetch(key);',
  "import { fetch } from './cache.js';\nconst row = fetch(key);",
  "import { load as fetch } from './cache.js';\nconst row = fetch(key);",
  'class Agent {}\nconst agent = new Agent({ keepAlive: true });',
  'class Pool {}\nconst pool = new Pool(origin, options);',
  'class Dispatcher {}\nclass Outbound extends Dispatcher {}',
  'class ProxyAgent {}\nclass Tunnel extends ProxyAgent {}',
  "import { Agent } from './model-agent.js';\nconst agent = new Agent({ keepAlive: true });",
  "import { Pool } from './worker-pool.js';\nconst pool = new Pool(origin, options);",
  "import { Dispatcher } from './events.js';\nclass Outbound extends Dispatcher {}",
  "import { ProxyAgent } from './proxy-model.js';\nconst proxy = new ProxyAgent({ uri });",
  "import * as u from './pools.js';\nconst pool = new u.Pool(origin, options);",
  "import { Agent as A } from './model-agent.js';\nconst agent = new A({ keepAlive: true });",
];

describe('the scanner recognises every way the code builds an outbound client', () => {
  it.each(CONSTRUCTIONS)('finds $line under $imports', (construction) => {
    expect(clientsInSource(sourceOf(construction))).toEqual([construction.line]);
  });

  it.each(ALIASED_GLOBAL_FETCH)('finds the call of the global fetch through an alias in $source', ({ source, call }) => {
    expect(clientsInSource(source)).toContain(call);
  });

  it('finds the OTLP agent, which is the one sanctioned place outside the factory', () => {
    expect(offenders().has('observability/src/otlp-agent.ts')).toBe(true);
  });

  it('refuses the same construction in a file that is not sanctioned', () => {
    const lines = CONSTRUCTIONS.flatMap((construction) => clientsInSource(sourceOf(construction)));
    const refused = outsideAllowed(new Map([['gateway/src/some-client.ts', lines], ['observability/src/otlp-agent.ts', lines]]));
    expect(refused).toHaveLength(1);
    expect(refused[0]?.startsWith('gateway/src/some-client.ts: ')).toBe(true);
    expect(refused[0]?.split(' | ')).toHaveLength(CONSTRUCTIONS.length);
  });

  it('does not take an unrelated class or call for a client', () => {
    expect(clientsInSource('class Failure extends Error {}')).toEqual([]);
    expect(clientsInSource("import http from 'node:http';\nconst response = await http.request({ method: 'GET', path });")).toEqual([]);
  });

  it.each(LOCAL_NAMES)('does not take a name bound in the file to something that is not a network client for one, in %s', (source) => {
    expect(clientsInSource(source)).toEqual([]);
  });

  it('does not take the fetch parameter of fillPage in the runtime store for the global fetch', () => {
    expect(offenders().has('store/src/runtime-store.ts')).toBe(false);
  });
});
