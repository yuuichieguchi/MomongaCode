import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const configFile = path.join(repoRoot, 'vitest.config.ts');
const GENERATED = /\.generated\.ts$/;
const SOURCE_PATTERNS = [
  /^\s*(?:import|export)\s+(?!type\b)[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const specifiersOf = (text: string): string[] => SOURCE_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1] as string));

const firstExisting = (candidates: readonly string[]): string | undefined => candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());

type ExportTarget = string | { readonly default?: string; readonly import?: string };

const workspaceTarget = (specifier: string): string | undefined => {
  const [scope, name, ...rest] = specifier.split('/');
  const packageDir = fs.realpathSync(path.join(repoRoot, 'node_modules', scope as string, name as string));
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { exports?: Record<string, ExportTarget> };
  const subpath = rest.length === 0 ? '.' : `./${rest.join('/')}`;
  const exported = manifest.exports?.[subpath];
  if (exported === undefined) throw new Error(`${specifier} has no export ${subpath} in ${packageDir}`);
  const target = typeof exported === 'string' ? exported : (exported.default ?? exported.import);
  if (target === undefined) throw new Error(`${specifier} has no default or import target in ${packageDir}`);
  const file = path.join(packageDir, target);
  return fs.existsSync(file) ? file : undefined;
};

const resolveSpecifier = (from: string, specifier: string): string | undefined => {
  if (specifier.startsWith('.')) {
    const base = path.resolve(path.dirname(from), specifier);
    return firstExisting([base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]);
  }
  if (specifier.startsWith('@momonga/')) return workspaceTarget(specifier);
  return undefined;
};

const reachedFrom = (entry: string): string[] => {
  const reached = new Set<string>([entry]);
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    for (const specifier of specifiersOf(fs.readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, specifier);
      if (target === undefined || reached.has(target)) continue;
      reached.add(target);
      pending.push(target);
    }
  }
  return [...reached].map((file) => path.relative(repoRoot, file)).sort();
};

describe('the static imports of vitest.config.ts', () => {
  const reached = reachedFrom(configFile);

  it('reach the timeout values and the formula modules, so the scan follows the chain it is meant to check', () => {
    expect(reached).toContain('e2e/support/vitest-timeouts.ts');
    expect(reached).toContain('test/formal/tlc-rows.ts');
  });

  it('reach no generated module, so the config loads on a fresh tree before the thread-module setup writes the generated files', () => {
    expect(reached.filter((file) => GENERATED.test(file))).toEqual([]);
  });
});

describe('the timeouts the vitest config takes from the e2e waits', () => {
  it('equal the values the e2e waits derive, so the config never needs the derivation', async () => {
    const waits = await import('../e2e/support/wait.ts');
    const config = await import('../e2e/support/vitest-timeouts.ts');
    expect(config.DEFAULT_TEST_TIMEOUT_MS).toBe(waits.DEFAULT_TEST_TIMEOUT_MS);
    expect(config.E2E_HOOK_TIMEOUT_MS).toBe(waits.E2E_HOOK_TIMEOUT_MS);
  });
});
