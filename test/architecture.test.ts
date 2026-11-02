import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');

const ALL_PACKAGES = [
  'protocol',
  'foundation',
  'config',
  'store',
  'observability',
  'gateway',
  'policy',
  'sandbox',
  'tools',
  'mcp',
  'context',
  'skills',
  'runtime',
  'supervisor',
  'cli',
  'testkit',
] as const;

interface PackageRule {
  static: readonly string[];
  dynamic: readonly string[];
}

const rule = (staticDeps: readonly string[], dynamicDeps: readonly string[] = []): PackageRule => ({
  static: staticDeps,
  dynamic: dynamicDeps,
});

const MATRIX: Record<string, PackageRule> = {
  protocol: rule([]),
  foundation: rule([]),
  config: rule(['protocol', 'foundation']),
  store: rule(['protocol', 'foundation']),
  observability: rule(['foundation']),
  gateway: rule(['protocol', 'foundation', 'config', 'observability']),
  policy: rule(['protocol', 'foundation', 'config']),
  sandbox: rule(['foundation']),
  tools: rule(['protocol', 'foundation', 'policy', 'sandbox']),
  mcp: rule(['protocol', 'foundation', 'config', 'tools']),
  context: rule(['protocol', 'foundation']),
  skills: rule(['protocol', 'foundation', 'config', 'tools']),
  runtime: rule(['protocol', 'foundation', 'config', 'store', 'observability', 'policy', 'sandbox', 'tools', 'mcp', 'context', 'skills']),
  supervisor: rule(['protocol', 'foundation', 'config']),
  cli: rule(['protocol', 'foundation', 'config'], ['runtime', 'gateway', 'supervisor']),
  testkit: rule(['protocol', 'foundation']),
};

export interface ImportSpecifier {
  specifier: string;
  dynamic: boolean;
}

export interface Violation {
  file: string;
  specifier: string;
  reason: string;
}

const STATIC_PATTERNS = [
  /\b(?:import|export)\s+(?:type\s+)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
];
const DYNAMIC_PATTERN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export const extractImports = (source: string): ImportSpecifier[] => {
  const found: ImportSpecifier[] = [];
  for (const pattern of STATIC_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.push({ specifier: match[1] as string, dynamic: false });
  }
  for (const match of source.matchAll(DYNAMIC_PATTERN)) found.push({ specifier: match[1] as string, dynamic: true });
  return found;
};

const internalPackageOf = (specifier: string): string | undefined => {
  const match = /^@momonga\/([^/]+)/.exec(specifier);
  return match?.[1];
};

export const checkFile = (packageName: string, filePath: string, source: string): Violation[] => {
  const packageRule = MATRIX[packageName];
  if (packageRule === undefined) return [{ file: filePath, specifier: '', reason: `unknown package ${packageName}` }];
  const violations: Violation[] = [];
  const packageRoot = path.join(packagesDir, packageName);
  for (const { specifier, dynamic } of extractImports(source)) {
    if (specifier.startsWith('.')) {
      const resolved = path.resolve(path.dirname(filePath), specifier);
      if (resolved !== packageRoot && !resolved.startsWith(packageRoot + path.sep)) {
        violations.push({ file: filePath, specifier, reason: 'relative import escapes the package' });
      }
      continue;
    }
    const target = internalPackageOf(specifier);
    if (target === undefined || target === packageName) continue;
    if (target === 'testkit') {
      violations.push({ file: filePath, specifier, reason: 'only testkit may import @momonga/testkit' });
      continue;
    }
    const allowed = packageRule.static.includes(target) || (dynamic && packageRule.dynamic.includes(target));
    if (!allowed) {
      violations.push({
        file: filePath,
        specifier,
        reason: `${packageName} may not ${dynamic ? 'dynamically ' : ''}import ${target}`,
      });
    }
  }
  return violations;
};

export const checkManifest = (packageName: string, dependencies: Record<string, string>): string[] => {
  const packageRule = MATRIX[packageName];
  if (packageRule === undefined) return [`unknown package ${packageName}`];
  const allowed = new Set([...packageRule.static, ...packageRule.dynamic]);
  return Object.keys(dependencies)
    .map(internalPackageOf)
    .filter((target): target is string => target !== undefined && target !== packageName && !allowed.has(target))
    .map((target) => `${packageName} must not depend on @momonga/${target}`);
};

const listSourceFiles = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
};

const packageNames = fs
  .readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('architecture: dependency matrix', () => {
  it('knows every package in the workspace', () => {
    expect(packageNames).toEqual([...ALL_PACKAGES].sort());
  });

  it.each(packageNames)('%s src imports respect the matrix', (packageName) => {
    const violations = listSourceFiles(path.join(packagesDir, packageName, 'src')).flatMap((file) =>
      checkFile(packageName, file, fs.readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it.each(packageNames)('%s package.json internal dependencies respect the matrix', (packageName) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(packagesDir, packageName, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    expect(checkManifest(packageName, dependencies)).toEqual([]);
  });
});

describe('architecture: checker self-test', () => {
  const fileIn = (packageName: string): string => path.join(packagesDir, packageName, 'src', 'index.ts');

  it('extracts static, type-only, side-effect, re-export and dynamic specifiers', () => {
    const source = [
      "import { a } from '@momonga/a';",
      "import type { B } from '@momonga/b';",
      "import '@momonga/c';",
      "export * from '@momonga/d';",
      "export { e } from '@momonga/e';",
      "const f = await import('@momonga/f');",
      'import {\n  g,\n  h,\n} from "@momonga/g";',
    ].join('\n');
    expect(extractImports(source)).toEqual(
      expect.arrayContaining([
        { specifier: '@momonga/a', dynamic: false },
        { specifier: '@momonga/b', dynamic: false },
        { specifier: '@momonga/c', dynamic: false },
        { specifier: '@momonga/d', dynamic: false },
        { specifier: '@momonga/e', dynamic: false },
        { specifier: '@momonga/f', dynamic: true },
        { specifier: '@momonga/g', dynamic: false },
      ]),
    );
  });

  it('flags a leaf package importing another package', () => {
    expect(checkFile('protocol', fileIn('protocol'), "import { x } from '@momonga/foundation';")).toHaveLength(1);
  });

  it('flags gateway importing store', () => {
    expect(checkFile('gateway', fileIn('gateway'), "import { s } from '@momonga/store';")).toHaveLength(1);
  });

  it('flags type-only and re-export violations', () => {
    expect(checkFile('foundation', fileIn('foundation'), "import type { T } from '@momonga/protocol';")).toHaveLength(1);
    expect(checkFile('policy', fileIn('policy'), "export * from '@momonga/tools';")).toHaveLength(1);
  });

  it('flags runtime importing gateway', () => {
    expect(checkFile('runtime', fileIn('runtime'), "import { createGateway } from '@momonga/gateway';")).toHaveLength(1);
    expect(checkManifest('runtime', { '@momonga/gateway': '*' })).toEqual(['runtime must not depend on @momonga/gateway']);
  });

  it('allows supervisor to import protocol, foundation and config only', () => {
    expect(
      checkFile(
        'supervisor',
        fileIn('supervisor'),
        "import { a } from '@momonga/protocol';\nimport { b } from '@momonga/foundation';\nimport { c } from '@momonga/config';",
      ),
    ).toEqual([]);
    expect(checkFile('supervisor', fileIn('supervisor'), "import { r } from '@momonga/runtime';")).toHaveLength(1);
    expect(checkFile('supervisor', fileIn('supervisor'), "const g = await import('@momonga/gateway');")).toHaveLength(1);
    expect(checkFile('supervisor', fileIn('supervisor'), "import { o } from '@momonga/observability';")).toHaveLength(1);
    expect(checkFile('supervisor', fileIn('supervisor'), "import { t } from '@momonga/testkit';")).toHaveLength(1);
    expect(checkManifest('supervisor', { '@momonga/runtime': '*' })).toEqual(['supervisor must not depend on @momonga/runtime']);
    expect(checkManifest('supervisor', { '@momonga/protocol': '*', '@momonga/foundation': '*', '@momonga/config': '*' })).toEqual([]);
  });

  it('flags runtime and gateway importing supervisor', () => {
    expect(checkFile('runtime', fileIn('runtime'), "import { s } from '@momonga/supervisor';")).toHaveLength(1);
    expect(checkFile('gateway', fileIn('gateway'), "const s = await import('@momonga/supervisor');")).toHaveLength(1);
  });

  it('flags runtime importing cli', () => {
    expect(checkFile('runtime', fileIn('runtime'), "import '@momonga/cli';")).toHaveLength(1);
  });

  it('allows cli to import runtime, gateway and supervisor only dynamically', () => {
    expect(checkFile('cli', fileIn('cli'), "const r = await import('@momonga/runtime');")).toEqual([]);
    expect(checkFile('cli', fileIn('cli'), "const g = await import('@momonga/gateway');")).toEqual([]);
    expect(checkFile('cli', fileIn('cli'), "const s = await import('@momonga/supervisor');")).toEqual([]);
    expect(checkFile('cli', fileIn('cli'), "import { run } from '@momonga/runtime';")).toHaveLength(1);
    expect(checkFile('cli', fileIn('cli'), "import { g } from '@momonga/gateway';")).toHaveLength(1);
    expect(checkFile('cli', fileIn('cli'), "import { startSupervisor } from '@momonga/supervisor';")).toHaveLength(1);
    expect(checkFile('cli', fileIn('cli'), "const s = await import('@momonga/store');")).toHaveLength(1);
    expect(checkFile('cli', fileIn('cli'), "import { c } from '@momonga/config';")).toEqual([]);
  });

  it('forbids @momonga/testkit everywhere except testkit', () => {
    expect(checkFile('runtime', fileIn('runtime'), "import { f } from '@momonga/testkit';")).toHaveLength(1);
    expect(checkFile('cli', fileIn('cli'), "const t = await import('@momonga/testkit');")).toHaveLength(1);
    expect(checkFile('testkit', fileIn('testkit'), "import { f } from '@momonga/testkit';")).toEqual([]);
  });

  it('flags relative imports that escape the package', () => {
    expect(checkFile('gateway', fileIn('gateway'), "import { s } from '../../store/src/index.ts';")).toHaveLength(1);
    expect(checkFile('gateway', fileIn('gateway'), "import { s } from './probe.ts';")).toEqual([]);
    expect(checkFile('cli', path.join(packagesDir, 'cli', 'src', 'main.ts'), "import p from '../package.json';")).toEqual([]);
  });

  it('allows permitted imports and external packages', () => {
    expect(
      checkFile('gateway', fileIn('gateway'), "import { a } from '@momonga/foundation';\nimport { Agent } from 'undici';"),
    ).toEqual([]);
  });

  it('flags manifest dependencies outside the matrix', () => {
    expect(checkManifest('gateway', { '@momonga/store': '*', undici: '1' })).toEqual([
      'gateway must not depend on @momonga/store',
    ]);
    expect(checkManifest('cli', { '@momonga/runtime': '*', '@momonga/gateway': '*', '@momonga/supervisor': '*' })).toEqual([]);
    expect(checkManifest('tools', { '@momonga/testkit': '*' })).toHaveLength(1);
  });
});

const UNKNOWN_WRITER_CALL = /\b(markUnknown|markUnknownIfPending)\s*\((?![^()]*\)\s*[:{])/g;
const UNKNOWN_WRITER_ALLOWLIST = ['packages/tools/src/executor.ts'];

export const unknownWriterCalls = (source: string): string[] => [...source.matchAll(UNKNOWN_WRITER_CALL)].map((match) => match[1] as string);

const srcFilesOf = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'test' ? [] : srcFilesOf(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });

const unknownWritersByFile = (): Record<string, string[]> =>
  Object.fromEntries(
    fs
      .readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(packagesDir, entry.name, 'src')))
      .flatMap((entry) => srcFilesOf(path.join(packagesDir, entry.name, 'src')))
      .map((file) => [path.relative(root, file), unknownWriterCalls(fs.readFileSync(file, 'utf8'))] as const)
      .filter(([, calls]) => calls.length > 0),
  );

describe('architecture: UNKNOWN has one writer', () => {
  it('markUnknownIfPending and markUnknown are called only from the executor abandon', () => {
    const writers = unknownWritersByFile();

    expect(Object.keys(writers).filter((file) => !UNKNOWN_WRITER_ALLOWLIST.includes(file))).toEqual([]);
    expect(Object.keys(writers)).toEqual(['packages/tools/src/executor.ts']);
    const executorCalls = writers['packages/tools/src/executor.ts'] ?? [];
    expect(executorCalls.length).toBeGreaterThanOrEqual(1);
    expect(executorCalls.every((name) => name === 'markUnknownIfPending')).toBe(true);
  });

  it('the matcher finds identifier calls but not declarations, definitions or prepared statements', () => {
    expect(unknownWriterCalls('idempotency.markUnknownIfPending(target.idemKey);')).toEqual(['markUnknownIfPending']);
    expect(unknownWriterCalls('const { markUnknown } = port;\nmarkUnknown(key);')).toEqual(['markUnknown']);
    expect(unknownWriterCalls('markUnknownIfPending(key: string): boolean;\nmarkUnknown(key: string): void;')).toEqual([]);
    expect(unknownWriterCalls('markUnknownIfPending: (key) => Number(markUnknown.run({ key }).changes) === 1,')).toEqual([]);
    expect(unknownWriterCalls('markUnknownIfPending(key) {\n  return true;\n}')).toEqual([]);
    expect(unknownWriterCalls('if (!idempotency.markUnknownIfPending(key)) return;')).toEqual(['markUnknownIfPending']);
    expect(unknownWriterCalls("const markUnknown = db.prepare(\"UPDATE idempotency SET state = 'UNKNOWN'\");")).toEqual([]);
  });
});

const RUN_PROBE_MODULE = path.join(packagesDir, 'gateway', 'src', 'probe', 'run-probe.ts');
const GATEWAY_BARREL = path.join(packagesDir, 'gateway', 'src', 'index.ts');

const runProbeImporters = (): string[] =>
  packageNames
    .flatMap((name) => listSourceFiles(path.join(packagesDir, name, 'src')))
    .filter((file) => file !== RUN_PROBE_MODULE && file !== GATEWAY_BARREL)
    .filter((file) => {
      const source = fs.readFileSync(file, 'utf8');
      const named = [...source.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)].some(
        ([, names, specifier]) => /\brunProbe\b/.test(names ?? '') && (specifier === '@momonga/gateway' || /run-probe(\.ts)?$/.test(specifier ?? '')),
      );
      const dynamic = /\bimport\(\s*['"](?:@momonga\/gateway|[^'"]*run-probe(?:\.ts)?)['"]\s*\)[\s\S]{0,200}?\brunProbe\b/.test(source);
      const namespace = /\bimport\s+\*\s+as\s+(\w+)\s+from\s*['"]@momonga\/gateway['"]/.exec(source);
      const viaNamespace = namespace !== null && new RegExp(`\\b${namespace[1]}\\.runProbe\\b`).test(source);
      return named || dynamic || viaNamespace;
    })
    .map((file) => path.relative(root, file));

describe('architecture: the probe runs only on request', () => {
  it('runProbe is imported only by the explicit probe command of the gateway package', () => {
    expect(runProbeImporters()).toEqual(['packages/gateway/src/probe/probe-fm.ts']);
  });
});
