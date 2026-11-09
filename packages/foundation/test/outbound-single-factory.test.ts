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

describe('every outbound HTTP client comes from the one factory', () => {
  const found = offenders();
  const allowed = new Set([FACTORY, ...KEPT.map((entry) => entry.file), ...BURN_DOWN.map((entry) => entry.file)]);

  it('no source file outside the factory builds an undici agent or calls fetch', () => {
    const outside = [...found].filter(([file]) => !allowed.has(file)).map(([file, lines]) => `${file}: ${lines.map((line) => line.trim()).join(' | ')}`);
    expect(outside).toEqual([]);
  });

  it('the factory module is where the agents are built', () => {
    expect(found.has(FACTORY)).toBe(true);
  });

  it('every kept and burn-down entry still holds a client, so a stale entry cannot hide a new one', () => {
    const stale = [...KEPT, ...BURN_DOWN].map((entry) => entry.file).filter((file) => !found.has(file));
    expect(stale).toEqual([]);
  });
});
