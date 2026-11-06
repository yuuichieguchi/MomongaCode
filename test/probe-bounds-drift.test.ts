import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { RUNTIME_ABORT_BUDGET_MS, RUNTIME_TEARDOWN_BUDGET_MS } from '@momonga/foundation';
import { ORPHAN_REAP_GRACE_MS } from '@momonga/supervisor';

const ROOT = path.resolve(import.meta.dirname, '..');

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const PROBE_CALL = /\b(findHolders|holdersOf|markerState|reconcileProcessGroup|reapMarkedProcesses|reapMarkedProcessesWithReport)\(/g;

const callTextFrom = (text: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  return text.slice(open);
};

const callsWithoutSignal = (relative: string): string[] => {
  const text = read(relative);
  const found: string[] = [];
  for (const match of text.matchAll(PROBE_CALL)) {
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const line = text.slice(lineStart, text.indexOf('\n', match.index));
    if (line.trim().startsWith('import') || line.includes('typeof ')) continue;
    const call = callTextFrom(text, match.index + match[0].length - 1);
    if (!/\bsignal\b/.test(call)) found.push(`${relative}:${text.slice(0, match.index).split('\n').length}: ${line.trim()}`);
  }
  return found;
};

describe('T4 (d) every caller of a probe passes the signal of its operation', () => {
  it.for([
    'packages/supervisor/src/orphans.ts',
    'packages/runtime/src/process/tool-markers.ts',
    'packages/runtime/src/process/background-jobs.ts',
    'packages/tools/src/builtins/bash.ts',
    'packages/tools/src/hooks/run.ts',
  ])('%s calls no probe without a signal', (relative) => {
    expect(callsWithoutSignal(relative)).toEqual([]);
  });
});

describe('T12 no private probe number remains and the + 2000 margins are gone', () => {
  it('foundation exports no constant named *_PROBE_TIMEOUT_MS', () => {
    expect(Object.keys(foundation).filter((name) => name.endsWith('_PROBE_TIMEOUT_MS'))).toEqual([]);
  });

  it('ORPHAN_REAP_GRACE_MS is the abort budget plus the teardown budget, with no margin', () => {
    expect(ORPHAN_REAP_GRACE_MS).toBe(RUNTIME_ABORT_BUDGET_MS + RUNTIME_TEARDOWN_BUDGET_MS);
  });

  it('the orphan phase deadline and the default orphanGraceMs are runtimeMaxCloseMs(d) with no margin', () => {
    const orphans = read('packages/supervisor/src/orphans.ts');
    expect(orphans).not.toContain('PHASE_ONE_MARGIN_MS');
    expect(orphans).toMatch(/Math\.min\(options\.orphanGraceMs, runtimeMaxCloseMs\([^)]*\)\)/);
    expect(read('packages/supervisor/src/start-supervisor.ts')).toMatch(/orphanGraceMs: options\.orphanGraceMs \?\? runtimeMaxCloseMs\(drainTimeoutMs\),/);
    expect(read('packages/supervisor/src/constants.ts')).not.toMatch(/ORPHAN_REAP_GRACE_MS = [^;\n]*\+ 2000/);
  });
});
