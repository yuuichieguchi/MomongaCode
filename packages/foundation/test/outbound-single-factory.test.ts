import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packagesDir = path.resolve(import.meta.dirname, '..', '..');

const OUTBOUND_CLIENT = [
  /\bnew\s+(?:Agent|ProxyAgent|EnvHttpProxyAgent|Socks5ProxyAgent)\s*\(/,
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
  { file: 'cli/src/update/node-ports.ts', owner: 'N4' },
];

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

const clientsIn = (text: string): string[] =>
  text.split('\n').filter((line) => OUTBOUND_CLIENT.some((pattern) => pattern.test(line)));

const offenders = (): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  const excluded = new Set(EXCLUDED_PACKAGES.map((entry) => entry.file));
  for (const pkg of fs.readdirSync(packagesDir)) {
    const src = path.join(packagesDir, pkg, 'src');
    if (excluded.has(pkg) || !fs.existsSync(src)) continue;
    for (const file of sourceFiles(src)) {
      const lines = clientsIn(fs.readFileSync(file, 'utf8'));
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

const CONSTRUCTIONS: readonly string[] = [
  'const agent = new Agent({ keepAlive: true });',
  'const agent = new http.Agent({ keepAlive: true });',
  'const agent = new https.Agent({ keepAlive: true });',
  'const agent = new HttpsProxyAgent(proxyUrl);',
  'const proxy = new ProxyAgent({ uri });',
  'const pool = new Pool(origin, options);',
  'class Routed extends HttpsProxyAgent<string> {',
  'class Direct extends http.Agent {',
  'class Secure extends https.Agent {',
  'class Undici extends Agent {',
  'class Tunnel extends ProxyAgent {',
  'class Outbound extends Dispatcher {',
  'const build = (base: typeof http.Agent): http.Agent => new (class extends base {})();',
  'const build = (base: typeof https.Agent): https.Agent => new (class extends base {})();',
  'const response = await fetch(url);',
];

describe('the scanner recognises every way the code builds an outbound client', () => {
  it.each(CONSTRUCTIONS)('finds %s', (line) => {
    expect(clientsIn(line)).toEqual([line]);
  });

  it('finds the OTLP agent, which is the one sanctioned place outside the factory', () => {
    expect(offenders().has('observability/src/otlp-agent.ts')).toBe(true);
  });

  it('refuses the same construction in a file that is not sanctioned', () => {
    const fixture = CONSTRUCTIONS.join('\n');
    const refused = outsideAllowed(new Map([['gateway/src/some-client.ts', clientsIn(fixture)], ['observability/src/otlp-agent.ts', clientsIn(fixture)]]));
    expect(refused).toHaveLength(1);
    expect(refused[0]?.startsWith('gateway/src/some-client.ts: ')).toBe(true);
    expect(refused[0]?.split(' | ')).toHaveLength(CONSTRUCTIONS.length);
  });

  it('does not take an unrelated class or call for a client', () => {
    expect(clientsIn('class Failure extends Error {')).toEqual([]);
    expect(clientsIn('const response = await http.request({ method: "GET", path });')).toEqual([]);
  });
});
