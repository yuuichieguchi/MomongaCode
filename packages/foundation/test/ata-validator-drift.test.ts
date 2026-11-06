import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url));
const COPY = path.join(REPOSITORY, 'packages', 'ata-validator');
const UPSTREAM_RECORD = path.join(COPY, 'UPSTREAM.md');
const DIFFERING_HEADING = '## Files that differ from upstream';

type Upstream = { package: string; version: string; algorithm: string; files: Record<string, string> };
const upstream = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/ata-validator-upstream/1.63.1.json', import.meta.url)), 'utf8')) as Upstream;

const walk = (directory: string): string[] =>
  readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : walk(full);
      return [full];
    });

const copiedFiles = (): string[] => walk(COPY).map((file) => path.relative(COPY, file).split(path.sep).join('/'));

const digest = (relative: string): string => createHash('sha256').update(readFileSync(path.join(COPY, relative))).digest('hex');

const listedAsDiffering = (record: string): string[] => {
  const start = record.indexOf(DIFFERING_HEADING);
  if (start < 0) return [];
  const rest = record.slice(start + DIFFERING_HEADING.length);
  const end = rest.search(/\n## /);
  const section = end < 0 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1] as string);
};

describe('the recorded upstream digests', () => {
  it('describe ata-validator 1.63.1 as published, with sha256 of every file', () => {
    expect({ package: upstream.package, version: upstream.version, algorithm: upstream.algorithm }).toEqual({ package: 'ata-validator', version: '1.63.1', algorithm: 'sha256' });
    expect(Object.keys(upstream.files)).toContain('LICENSE');
    expect(Object.keys(upstream.files)).toContain('lib/interpreter-core.js');
    expect(Object.keys(upstream.files)).toContain('lib/safe-regex.js');
  });
});

describe('packages/ata-validator, the repository copy of ata-validator 1.63.1 (decision 60)', () => {
  it('is the private workspace package @momonga/ata-validator', () => {
    const manifest = JSON.parse(readFileSync(path.join(COPY, 'package.json'), 'utf8')) as { name?: string; private?: boolean; version?: string };
    expect({ name: manifest.name, private: manifest.private, version: manifest.version }).toEqual({ name: '@momonga/ata-validator', private: true, version: '1.63.1' });
  });

  it('keeps the upstream MIT LICENSE unchanged', () => {
    expect(digest('LICENSE')).toBe(upstream.files.LICENSE);
  });

  it('records the upstream repository and the version copied in UPSTREAM.md', () => {
    const record = readFileSync(UPSTREAM_RECORD, 'utf8');
    expect(record).toContain('github.com/ata-core/ata-validator');
    expect(record).toContain('1.63.1');
    expect(record).toContain(DIFFERING_HEADING);
  });

  it('equals upstream byte for byte in every file not listed in UPSTREAM.md', () => {
    const listed = new Set(listedAsDiffering(readFileSync(UPSTREAM_RECORD, 'utf8')));
    const drifted = copiedFiles()
      .filter((file) => file !== 'UPSTREAM.md' && !listed.has(file))
      .filter((file) => upstream.files[file] !== digest(file));
    expect(drifted).toEqual([]);
  });

  it('lists in UPSTREAM.md only files that exist in the copy and really differ from upstream', () => {
    const listed = listedAsDiffering(readFileSync(UPSTREAM_RECORD, 'utf8'));
    const present = new Set(copiedFiles());
    expect(listed.filter((file) => !present.has(file))).toEqual([]);
    expect(listed.filter((file) => upstream.files[file] === digest(file))).toEqual([]);
  });

  it('lists package.json and the files of the multipleOf and code-point fixes', () => {
    const listed = listedAsDiffering(readFileSync(UPSTREAM_RECORD, 'utf8'));
    expect(listed).toEqual(expect.arrayContaining(['package.json', 'lib/interpreter-core.js', 'lib/safe-regex.js']));
  });
});

describe('foundation loads the repository copy, not the npm package', () => {
  const foundationManifest = JSON.parse(readFileSync(path.join(REPOSITORY, 'packages', 'foundation', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };

  it('depends on @momonga/ata-validator and not on ata-validator', () => {
    expect(Object.keys(foundationManifest.dependencies)).toContain('@momonga/ata-validator');
    expect(Object.keys(foundationManifest.dependencies)).not.toContain('ata-validator');
  });

  it('has no import of the npm ata-validator left in foundation', () => {
    const sources = [...walk(path.join(REPOSITORY, 'packages', 'foundation', 'src')), ...walk(path.join(REPOSITORY, 'packages', 'foundation', 'test'))].filter((file) => /\.(ts|tsx|js|mjs)$/.test(file));
    const offenders = sources.filter((file) => /from\s+['"]ata-validator(\/[^'"]*)?['"]/.test(readFileSync(file, 'utf8'))).map((file) => path.relative(REPOSITORY, file));
    expect(offenders).toEqual([]);
  });

  it('has removed the npm ata-validator from the lockfile', () => {
    const lock = JSON.parse(readFileSync(path.join(REPOSITORY, 'package-lock.json'), 'utf8')) as { packages: Record<string, unknown> };
    expect(Object.keys(lock.packages).filter((key) => key === 'node_modules/ata-validator' || key.endsWith('/node_modules/ata-validator'))).toEqual([]);
    expect(existsSync(COPY)).toBe(true);
  });
});
