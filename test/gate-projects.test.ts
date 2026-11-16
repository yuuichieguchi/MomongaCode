import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEST_REUSE_ENV } from './support/reuse-observed.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

const scripts = (): Record<string, string> => (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

const GATE_PROJECTS = '--project unit --project e2e --project packaging';

describe('the merge gate', () => {
  it('runs the unit, the e2e and the packaging projects in one invocation, with the formal models and the unchanged test files reused', () => {
    expect(scripts()['test:reuse']).toBe(`${TEST_REUSE_ENV}=1 MOMONGA_TLC_REUSE=1 vitest run ${GATE_PROJECTS}`);
  });

  it('runs the same three projects without reuse for the release', () => {
    expect(scripts()['test']).toBe(`${TEST_REUSE_ENV}=0 MOMONGA_TLC_REUSE=0 vitest run ${GATE_PROJECTS}`);
  });

  it('keeps the single runs of the e2e and the packaging projects', () => {
    expect(scripts()['test:e2e']).toBe('vitest run --project e2e');
    expect(scripts()['test:packaging']).toBe('vitest run --project packaging');
  });
});
