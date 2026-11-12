import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = path.resolve(import.meta.dirname, '..');

const RESOLVER_MODULES = new Set(['packages/foundation/src/momonga-paths.ts', 'packages/foundation/src/current-generation.ts']);

const productSources = (): string[] => {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(full);
    }
  };
  for (const pkg of fs.readdirSync(path.join(root, 'packages'))) {
    const source = path.join(root, 'packages', pkg, 'src');
    if (fs.existsSync(source)) walk(source);
  }
  return found.map((file) => path.relative(root, file).split(path.sep).join('/'));
};

const offenders = (pattern: RegExp): string[] =>
  productSources()
    .filter((file) => !RESOLVER_MODULES.has(file))
    .flatMap((file) =>
      fs
        .readFileSync(path.join(root, file), 'utf8')
        .split('\n')
        .flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
    );

describe('one resolver decides which runtime, gateway and supervisor socket a client dials', () => {
  it('finds product sources to check', () => {
    expect(productSources()).toContain('packages/cli/src/run/open-session.ts');
  });

  it('reads no home-wide paths.sockets outside the resolver', () => {
    expect(offenders(/\bpaths\.sockets\b/)).toEqual([]);
    expect(offenders(/\bpaths\.sockets\[|\bsockets\[role\]/)).toEqual([]);
  });

  it('builds no runtime, gateway or supervisor socket path outside the resolver', () => {
    expect(offenders(/['"`/](runtime|gateway|supervisor)\.sock['"`]/)).toEqual([]);
  });

  it('constructs every runtime, gateway and supervisor client with a resolver, never with a fixed socket path', () => {
    expect(offenders(/create(Cli)?(Runtime|Gateway|Supervisor)Client\(\s*\{[^}]*\bsocketPath\s*:/)).toEqual([]);
  });

  it('keeps no fixed socketPath in the undici Agent of a resolving client', () => {
    const uds = fs.readFileSync(path.join(root, 'packages/foundation/src/uds.ts'), 'utf8');
    expect(uds).not.toMatch(/connect:\s*\{\s*socketPath\s*\}/);
  });
});
