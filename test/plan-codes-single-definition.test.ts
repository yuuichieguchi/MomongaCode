import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAN_CODES } from '@momonga/protocol';

const ROOT = path.resolve(import.meta.dirname, '..');

const ALLOWED_PLACES: readonly string[] = ['packages/protocol/src/', 'packages/config/src/plan-profiles.ts'];

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const codePatterns = (codes: readonly string[]): RegExp[] =>
  codes.flatMap((code) => [new RegExp(`(['"\`])${escaped(code)}\\1`, 'g'), new RegExp(`(?<![\\w$.'"\`])${escaped(code)}\\s*:(?!:)`, 'g')]);

const literalLines = (source: string, codes: readonly string[]): number[] =>
  codePatterns(codes)
    .flatMap((pattern) => [...source.matchAll(pattern)].map((match) => source.slice(0, match.index).split('\n').length))
    .sort((a, b) => a - b);

const sourceFiles = (relative: string): string[] =>
  fs
    .readdirSync(path.join(ROOT, relative), { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(?:ts|tsx|mts|mjs|js)$/.test(name) && !name.split(path.sep).includes('node_modules'))
    .map((name) => path.join(relative, name).split(path.sep).join('/'))
    .sort();

const scannedFiles = (): string[] =>
  [
    ...fs
      .readdirSync(path.join(ROOT, 'packages'))
      .filter((name) => fs.existsSync(path.join(ROOT, 'packages', name, 'src')))
      .flatMap((name) => sourceFiles(path.join('packages', name, 'src'))),
    ...sourceFiles('scripts'),
  ].filter((file) => !ALLOWED_PLACES.some((place) => file === place || (place.endsWith('/') && file.startsWith(place))));

describe('P-S13: a plan code produced or matched in code is a protocol constant', () => {
  it('no quoted literal or object key equal to a plan code outside protocol/src and config/src/plan-profiles.ts', () => {
    const found = scannedFiles().flatMap((file) => literalLines(fs.readFileSync(path.join(ROOT, file), 'utf8'), PLAN_CODES).map((line) => `${file}:${line}`));
    expect(found).toEqual([]);
  });

  it('refuses a quoted code, a code as an object key and a code as a case label, and not the constant name', () => {
    expect(literalLines("const code = 'sign_in_required';", PLAN_CODES)).toEqual([1]);
    expect(literalLines('const table = { sign_in_required: 401 };', PLAN_CODES)).toEqual([1]);
    expect(literalLines("switch (code) {\n  case 'plan_usage_paused':\n    break;\n}", PLAN_CODES)).toEqual([2]);
    expect(literalLines('const code = SIGN_IN_REQUIRED_CODE;', PLAN_CODES)).toEqual([]);
  });

  it('the TUI has no copy of USAGE_PAUSED_CODE', () => {
    expect(fs.readFileSync(path.join(ROOT, 'packages/cli/src/tui/app.tsx'), 'utf8')).not.toMatch(/\bconst\s+USAGE_PAUSED_CODE\b/);
  });
});
