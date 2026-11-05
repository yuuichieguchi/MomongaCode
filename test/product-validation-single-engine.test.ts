import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');
const AJV_MODULES = ['ajv', 'ajv-formats'] as const;
const AJV_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](ajv(?:\/[^'"]*)?|ajv-formats(?:\/[^'"]*)?)['"]/gm;
const RUNTIME_DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

const packageNames = (): string[] =>
  fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(packagesDir, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort();

const sourceFilesUnder = (directory: string): string[] => {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFilesUnder(full);
    return /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
};

const ajvImportsOf = (file: string): string[] => [...fs.readFileSync(file, 'utf8').matchAll(AJV_SPECIFIER)].map((match) => match[1] ?? '');

describe('the product validates its own data through one engine', () => {
  it('finds every package', () => {
    expect(packageNames().length).toBeGreaterThanOrEqual(20);
  });

  it('has no runtime source in any package that imports Ajv', () => {
    const offenders = packageNames().flatMap((name) =>
      sourceFilesUnder(path.join(packagesDir, name, 'src')).flatMap((file) => ajvImportsOf(file).map((specifier) => `${path.relative(root, file)} imports ${specifier}`)),
    );
    expect(offenders).toEqual([]);
  });

  it('recognises every form of Ajv import the scan must catch', () => {
    const forms = [
      "import Ajv2020 from 'ajv/dist/2020.js';",
      "import type { JSONSchemaType } from 'ajv';",
      "import addFormats from 'ajv-formats';",
      "const lazy = await import('ajv/dist/2020');",
      "import 'ajv';",
    ].join('\n');
    expect([...forms.matchAll(AJV_SPECIFIER)].map((match) => match[1])).toEqual(['ajv/dist/2020.js', 'ajv', 'ajv-formats', 'ajv/dist/2020', 'ajv']);
  });

  it('keeps Ajv out of every package runtime dependency list', () => {
    const offenders = packageNames().flatMap((name) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(packagesDir, name, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
      return RUNTIME_DEPENDENCY_FIELDS.flatMap((field) => AJV_MODULES.filter((module) => manifest[field]?.[module] !== undefined).map((module) => `${name} ${field} ${module}`));
    });
    expect(offenders).toEqual([]);
  });

  it('keeps Ajv as a development dependency for the test-time lint', () => {
    const manifests = [path.join(root, 'package.json'), ...packageNames().map((name) => path.join(packagesDir, name, 'package.json'))].map(
      (file) => JSON.parse(fs.readFileSync(file, 'utf8')) as { devDependencies?: Record<string, string> },
    );
    expect(manifests.some((manifest) => manifest.devDependencies?.['ajv'] !== undefined)).toBe(true);
  });
});
