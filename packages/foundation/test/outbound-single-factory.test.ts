import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packagesDir = path.resolve(import.meta.dirname, '..', '..');

const CLIENT_CLASS = '(?:https?\\.)?(?:Agent|ProxyAgent|EnvHttpProxyAgent|Socks5ProxyAgent|HttpsProxyAgent|HttpProxyAgent|Pool|Dispatcher)';

const OUTBOUND_CLIENT = [
  new RegExp(`\\bnew\\s+${CLIENT_CLASS}\\s*[(<]`),
  new RegExp(`\\bextends\\s+${CLIENT_CLASS}\\b`),
  /\btypeof\s+https?\.Agent\b/,
  /(?<![.\w$])fetch\s*\(/,
  /\b(?:undici|globalThis)\.fetch\b/,
];

const FACTORY = 'foundation/src/outbound.ts';

const SANCTIONED: readonly Kept[] = [{ file: 'observability/src/otlp-agent.ts', reason: 'the node:http agent of the OTLP exporter, built from outboundPlan (design N5)' }];

type Kept = { file: string; reason: string };
type BurnDown = { file: string; owner: string };

const KEPT: readonly Kept[] = [{ file: 'foundation/src/uds.ts', reason: 'a Unix-socket client to the local daemon, never a network request' }];

const EXCLUDED_PACKAGES: readonly Kept[] = [{ file: 'testkit', reason: 'test support that drives fake servers on loopback; never shipped' }];

const BURN_DOWN: readonly BurnDown[] = [
  { file: 'mcp/src/remote-policy.ts', owner: 'N3' },
  { file: 'mcp/src/authorize.ts', owner: 'N3' },
];

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

const clientsIn = (text: string): string[] =>
  text.split('\n').filter((line) => OUTBOUND_CLIENT.some((pattern) => pattern.test(line)));

const clientsInSource = (source: string): string[] => clientsIn(source).map((line) => line.trim());

const offenders = (): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  const excluded = new Set(EXCLUDED_PACKAGES.map((entry) => entry.file));
  for (const pkg of fs.readdirSync(packagesDir)) {
    const src = path.join(packagesDir, pkg, 'src');
    if (excluded.has(pkg) || !fs.existsSync(src)) continue;
    for (const file of sourceFiles(src)) {
      const lines = clientsInSource(fs.readFileSync(file, 'utf8'));
      if (lines.length > 0) found.set(path.relative(packagesDir, file).split(path.sep).join('/'), lines);
    }
  }
  return found;
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
