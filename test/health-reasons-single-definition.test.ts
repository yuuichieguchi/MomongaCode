import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const ROOT = path.resolve(import.meta.dirname, '..');

const OWNER = 'packages/protocol/src/capabilities.ts';

const sourceFiles = (relative: string): string[] =>
  fs
    .readdirSync(path.join(ROOT, relative), { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => path.join(relative, name).split(path.sep).join('/'))
    .sort();

const packageSources = (): string[] =>
  fs
    .readdirSync(path.join(ROOT, 'packages'))
    .filter((name) => fs.existsSync(path.join(ROOT, 'packages', name, 'src')))
    .flatMap((name) => sourceFiles(path.join('packages', name, 'src')));

const quoted = (value: string): RegExp => new RegExp(`['"\`]${value}['"\`]`);

const holdsAll = (text: string, values: readonly string[]): boolean => values.every((value) => quoted(value).test(text));

const arrayLiterals = (source: string): string[] => [...source.matchAll(/\[[^[\]]*\]/g)].map((match) => match[0]);

const unionTypes = (source: string): string[] => [...source.matchAll(/\btype\s+[\w$]+(?:<[^>]*>)?\s*=[^;]*\|[^;]*;/g)].map((match) => match[0]);

const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('P-S12: the health reasons are defined once, by protocol', () => {
  it('no file outside protocol/src/capabilities.ts holds an array of the target health reasons, and no gateway or CLI file declares a union of the plan health reasons', () => {
    const arrayCopies = packageSources().filter((file) => file !== OWNER && arrayLiterals(read(file)).some((literal) => holdsAll(literal, ['health_check_failed', 'store_unreadable'])));
    const unionCopies = [...sourceFiles('packages/gateway/src'), ...sourceFiles('packages/cli/src')].filter((file) => unionTypes(read(file)).some((union) => holdsAll(union, ['plan_usage_paused', 'store_unwritable'])));
    expect({ arrayCopies, unionCopies }).toEqual({ arrayCopies: [], unionCopies: [] });
  });
});
