import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = path.resolve(import.meta.dirname, '..');

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return ['node_modules', 'test', 'dist'].includes(entry.name) ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.generated.ts') ? [full] : [];
  });

const sites = (pattern: RegExp): Array<{ file: string; line: number; text: string; lines: string[] }> =>
  sourceFiles(path.join(root, 'packages')).flatMap((file) => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    return lines.flatMap((text, index) => (pattern.test(text) ? [{ file: path.relative(root, file), line: index + 1, text, lines }] : []));
  });

const insideSweepPurge = ({ lines, line }: { lines: string[]; line: number }): boolean => lines.slice(Math.max(0, line - 12), line).some((text) => /\bpurges: \[|\bretentionPurge: async/.test(text));

describe('one retention sweep deletes the rows of every store (R6)', () => {
  it('the product calls the sweep from one place', () => {
    expect(sites(/\.retention\.sweep\(/).map(({ file, line }) => `${file}:${line}`)).toHaveLength(1);
  });

  it('only the sweep deletes sessions, runs and events', () => {
    const deleting = sites(/DELETE FROM "?(sessions|runs|events)"?\b/).map(({ file }) => file);
    expect([...new Set(deleting)]).toEqual([]);
  });

  it('the trace, gateway and work-tree observer stores are purged only by a purge of the sweep, with its cutoff', () => {
    const purgeCalls = sites(/\b(purgeRuns|pruneGitObserverStores|gatewayClient\.retentionPurge)\(/).filter(({ text }) => !/^\s*(export )?(const|function|async function) /.test(text) && !/purgeRuns\(runIds: readonly/.test(text));
    expect(purgeCalls.length).toBeGreaterThan(0);
    expect(purgeCalls.filter((site) => !insideSweepPurge(site)).map(({ file, line, text }) => `${file}:${line} ${text.trim()}`)).toEqual([]);
  });

  it('the legacy trace content is moved with the period of the cutoff the sweep sends with each purge, never a period read elsewhere', () => {
    const moves = sites(/\bmoveLegacyContent\(/).filter(({ text }) => !/^\s*(export )?(const|function|async function) |moveLegacyContent\(options:/.test(text));
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.filter((site) => !insideSweepPurge(site) || !/retentionMs: clock\.now\(\) - cutoffMs\b/.test(site.text)).map(({ file, line, text }) => `${file}:${line} ${text.trim()}`)).toEqual([]);
  });
});
