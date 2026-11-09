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

type ClientModule = { module: string; reason: string; clients: readonly string[] };

const CLIENT_MODULES: readonly ClientModule[] = [
  { module: 'node:http', reason: 'its Agent opens TCP connections to any host', clients: ['Agent'] },
  { module: 'http', reason: 'its Agent opens TCP connections to any host', clients: ['Agent'] },
  { module: 'node:https', reason: 'its Agent opens TLS connections to any host', clients: ['Agent'] },
  { module: 'https', reason: 'its Agent opens TLS connections to any host', clients: ['Agent'] },
  {
    module: 'undici',
    reason: 'its fetch sends requests and its dispatchers open connections to any host',
    clients: ['fetch', 'Agent', 'ProxyAgent', 'EnvHttpProxyAgent', 'Socks5ProxyAgent', 'Pool', 'Client', 'BalancedPool', 'RetryAgent', 'Dispatcher'],
  },
  { module: 'https-proxy-agent', reason: 'its agent tunnels connections through a proxy', clients: ['HttpsProxyAgent'] },
  { module: 'http-proxy-agent', reason: 'its agent sends requests through a proxy', clients: ['HttpProxyAgent'] },
  { module: 'socks-proxy-agent', reason: 'its agent opens connections through a SOCKS proxy', clients: ['SocksProxyAgent'] },
  { module: 'proxy-agent', reason: 'its agent opens connections through the proxy the environment names', clients: ['ProxyAgent'] },
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

const isClient = (ref: Ref): boolean => {
  if (ref.kind === 'globalFetch') return true;
  if (ref.kind !== 'export') return false;
  return clientModule(ref.module)?.clients.includes(ref.name) === true;
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

const TS_VALUE_NODES: ReadonlySet<string> = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
  'TSModuleDeclaration',
  'TSModuleBlock',
  'TSEnumDeclaration',
  'TSEnumBody',
  'TSEnumMember',
  'TSExportAssignment',
  'TSParameterProperty',
]);

const isTypeNode = (node: AstNode): boolean => node.type.startsWith('TS') && !TS_VALUE_NODES.has(node.type);

const NAMING_KEYS: ReadonlySet<string> = new Set(['id', 'label']);

const KEYED_MEMBERS: ReadonlySet<string> = new Set(['Property', 'MethodDefinition', 'PropertyDefinition', 'AccessorProperty', 'TSAbstractMethodDefinition', 'TSAbstractPropertyDefinition', 'TSAbstractAccessorProperty']);

const entriesOf = (node: AstNode): [string, AstNode][] =>
  Object.entries(node).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).filter(isNode).map((item): [string, AstNode] => [key, item]));

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

  const record = (node: AstNode, scope: Scope): boolean => {
    const client = isClient(resolveIn(node, scope, new Set()));
    if (client) found.add(lineAt(node.start));
    return client;
  };

  const visitPattern = (pattern: AstNode, scope: Scope, functionScope: Scope): void => {
    if (isTypeNode(pattern) || pattern.type === 'Identifier') return;
    if (pattern.type === 'MemberExpression') return visit(pattern, scope, functionScope);
    if (pattern.type === 'AssignmentPattern') {
      const left = child(pattern, 'left');
      const right = child(pattern, 'right');
      if (left !== undefined) visitPattern(left, scope, functionScope);
      if (right !== undefined) visit(right, scope, functionScope);
      return;
    }
    if (pattern.type === 'Property') {
      const key = child(pattern, 'key');
      const value = child(pattern, 'value');
      if (pattern.computed === true && key !== undefined) visit(key, scope, functionScope);
      if (value !== undefined) visitPattern(value, scope, functionScope);
      return;
    }
    for (const [, item] of entriesOf(pattern)) visitPattern(item, scope, functionScope);
  };

  const visitChildren = (node: AstNode, scope: Scope, functionScope: Scope, skip: ReadonlySet<string>): void => {
    for (const [key, item] of entriesOf(node)) if (!skip.has(key)) visit(item, scope, functionScope);
  };

  const NO_KEYS: ReadonlySet<string> = new Set();

  const visit = (node: AstNode, scope: Scope, functionScope: Scope): void => {
    if (isTypeNode(node)) return;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportSpecifier') return;
    if (node.type === 'Identifier') {
      record(node, scope);
      return;
    }
    if (node.type === 'MemberExpression') {
      if (record(node, scope)) return;
      return visitChildren(node, scope, functionScope, node.computed === true ? NO_KEYS : new Set(['property']));
    }
    if (KEYED_MEMBERS.has(node.type)) return visitChildren(node, scope, functionScope, node.computed === true ? NO_KEYS : new Set(['key']));
    if (node.type === 'VariableDeclarator') {
      const id = child(node, 'id');
      if (id !== undefined) visitPattern(id, scope, functionScope);
      return visitChildren(node, scope, functionScope, new Set(['id']));
    }
    if (node.type === 'AssignmentExpression') {
      const left = child(node, 'left');
      if (left !== undefined) visitPattern(left, scope, functionScope);
      return visitChildren(node, scope, functionScope, new Set(['left']));
    }
    if (FUNCTIONS.has(node.type)) {
      const inner: Scope = { bindings: new Map(), parent: scope };
      const name = nameOf(child(node, 'id'));
      if (name !== undefined && node.type === 'FunctionExpression') inner.bindings.set(name, { kind: 'local' });
      for (const param of children(node, 'params')) bindPattern(param, inner, undefined, []);
      for (const param of children(node, 'params')) visitPattern(param, inner, inner);
      for (const [key, item] of entriesOf(node)) if (!['body', 'params', 'id'].includes(key)) visit(item, inner, inner);
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
      const param = child(node, 'param');
      if (param !== undefined) visitPattern(param, inner, functionScope);
      const body = child(node, 'body');
      if (body !== undefined) visit(body, inner, functionScope);
      return;
    }
    if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      const head = child(node, node.type === 'ForStatement' ? 'init' : 'left');
      const inner = openScope(scope, head === undefined ? [] : [head], functionScope);
      return visitChildren(node, inner, functionScope, NO_KEYS);
    }
    if (node.type === 'ClassExpression') {
      const inner: Scope = { bindings: new Map(), parent: scope };
      const name = nameOf(child(node, 'id'));
      if (name !== undefined) inner.bindings.set(name, { kind: 'local' });
      for (const [key, item] of entriesOf(node)) if (!NAMING_KEYS.has(key)) visit(item, key === 'superClass' ? scope : inner, functionScope);
      return;
    }
    visitChildren(node, scope, functionScope, NAMING_KEYS);
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
  { imports: "import http from 'node:http';", line: 'const agent = build(http.Agent);' },
  { imports: "import https from 'node:https';", line: 'const agent = build(https.Agent);' },
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
  { imports: "import http from 'node:http';\nimport https from 'node:https';", line: 'const base = secure ? https.Agent : http.Agent;' },
  { imports: "import * as h from 'node:https';", line: 'const agent = new h.Agent({ keepAlive: true });' },
];

const sourceOf = (construction: Construction): string => [construction.imports, construction.line].filter((part) => part !== '').join('\n');

const ALIASED_GLOBAL_FETCH: readonly { source: string; call: string }[] = [
  { source: 'const f = fetch;\nconst response = await f(url);', call: 'const response = await f(url);' },
  { source: 'const { fetch: get } = globalThis;\nconst response = await get(url);', call: 'const response = await get(url);' },
  { source: 'const get = globalThis.fetch;\nconst response = await get(url);', call: 'const response = await get(url);' },
];

const VALUE_REFERENCES: readonly { source: string; line: string }[] = [
  { source: 'connect({ fetch });', line: 'connect({ fetch });' },
  { source: 'const options = { fetch: globalThis.fetch };', line: 'const options = { fetch: globalThis.fetch };' },
  { source: 'use(fetch);', line: 'use(fetch);' },
  { source: 'const senders = [fetch];', line: 'const senders = [fetch];' },
  { source: "import { fetch } from 'undici';\nuse(fetch);", line: 'use(fetch);' },
  { source: "import * as undici from 'undici';\nconnect({ fetch: undici.fetch });", line: 'connect({ fetch: undici.fetch });' },
  { source: "import { Agent } from 'undici';\nmake(Agent);", line: 'make(Agent);' },
  { source: "import https from 'node:https';\nconst kinds = [https.Agent];", line: 'const kinds = [https.Agent];' },
];

const TYPE_REFERENCES: readonly string[] = [
  'let send: typeof fetch;',
  'type Send = typeof globalThis.fetch;',
  "import { fetch } from 'undici';\ntype Send = typeof fetch;",
  'const options: { fetch: OutboundFetch | typeof fetch } = { fetch: outbound };',
  "import http from 'node:http';\nconst build = (base: typeof http.Agent): http.Agent => new (class extends base {})();",
  "import https from 'node:https';\nconst build = (base: typeof https.Agent): https.Agent => new (class extends base {})();",
  "import { Agent } from 'undici';\nlet agent: Agent;",
  "import type { Dispatcher } from 'undici';\nconst use = (dispatcher: Dispatcher): void => {};",
  "import http from 'node:http';\nconst agents: http.Agent[] = [];",
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

  it.each(VALUE_REFERENCES)('finds the client handed on as a value in $source', ({ source, line }) => {
    expect(clientsInSource(source)).toEqual([line]);
  });

  it.each(TYPE_REFERENCES)('does not take a client named only in a type for one, in %s', (source) => {
    expect(clientsInSource(source)).toEqual([]);
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
