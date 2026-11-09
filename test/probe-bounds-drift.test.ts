import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { DEFAULT_STOP_VALUES, MAXIMUM_STOP_VALUES, RUNTIME_ABORT_BUDGET_MS, orphanReapGraceMs, runtimeTeardownBudgetMs } from '@momonga/foundation';
import * as supervisor from '@momonga/supervisor';

const ROOT = path.resolve(import.meta.dirname, '..');

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const PROBE_CALL = /\b(findHolders|holdersOf|markerState|reconcileProcessGroup|reapMarkedProcesses|reapMarkedProcessesWithReport|reapMarkerDirectory|reapToolMarkers|reapDaemonMarker|terminateGroup|ensureMomongaDirs)\(/g;

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
    'packages/runtime/src/process/start-runtime-process.ts',
    'packages/supervisor/src/shutdown.ts',
    'packages/mcp/src/stdio-transport.ts',
    'packages/cli/src/paths.ts',
  ])('%s calls no probe without a signal', (relative) => {
    expect(callsWithoutSignal(relative)).toEqual([]);
  });
});

describe('T12 no private probe number remains and the + 2000 margins are gone', () => {
  it('foundation exports no constant named *_PROBE_TIMEOUT_MS', () => {
    expect(Object.keys(foundation).filter((name) => name.endsWith('_PROBE_TIMEOUT_MS'))).toEqual([]);
  });

  it('no fixed ORPHAN_REAP_GRACE_MS is exported: the orphan reap grace depends on the MCP grace of the predecessor stop', () => {
    expect('ORPHAN_REAP_GRACE_MS' in supervisor).toBe(false);
    expect('ORPHAN_REAP_GRACE_MS' in foundation).toBe(false);
  });

  it('orphanReapGraceMs(v) is the abort budget plus the teardown budget of the MCP grace of v, with no margin', () => {
    for (const values of [DEFAULT_STOP_VALUES, MAXIMUM_STOP_VALUES, { ...DEFAULT_STOP_VALUES, mcpCloseGraceMs: 0 }]) {
      expect(orphanReapGraceMs(values), JSON.stringify(values)).toBe(RUNTIME_ABORT_BUDGET_MS + runtimeTeardownBudgetMs(values.mcpCloseGraceMs));
    }
  });

  it('the orphan phase deadline and the default orphanGraceMs are runtimeMaxCloseMs of the predecessor values with no margin', () => {
    const orphans = read('packages/supervisor/src/orphans.ts');
    expect(orphans).not.toContain('PHASE_ONE_MARGIN_MS');
    expect(orphans).toMatch(/Math\.min\(\w+\.orphanGraceMs, runtimeMaxCloseMs\([^)]*\)\)/);
    const start = read('packages/supervisor/src/start-supervisor.ts');
    expect(start).not.toMatch(/runtimeMaxCloseMs\(drainTimeoutMs\)/);
    expect(start).toMatch(/runtimeMaxCloseMs\(/);
    expect(read('packages/supervisor/src/constants.ts')).not.toMatch(/ORPHAN_REAP_GRACE_MS = [^;\n]*\+ 2000/);
  });
});

const REAP_PATH_SOURCES = [
  'packages/foundation/src/process-markers.ts',
  'packages/foundation/src/process-group.ts',
  'packages/tools/src/executor.ts',
  'packages/tools/src/builtins/bash.ts',
  'packages/tools/src/hooks/run.ts',
  'packages/supervisor/src/orphans.ts',
  'packages/supervisor/src/shutdown.ts',
  'packages/runtime/src/process/tool-markers.ts',
  'packages/runtime/src/process/background-jobs.ts',
  'packages/runtime/src/process/start-runtime-process.ts',
  'packages/mcp/src/stdio-transport.ts',
];

const NEVER_ABORTING = [/NEVER_ABORTED/, /new AbortController\(\)\.signal/, /signal \?\? /, /signal = new AbortController/];

describe('PT 3G and HB2 rule 1: no reap-path probe gets a signal that never aborts', () => {
  it.for(REAP_PATH_SOURCES)('%s creates no never-aborting signal and has no fallback for a missing one', (relative) => {
    const text = read(relative);
    const found = text
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => NEVER_ABORTING.some((pattern) => pattern.test(line)))
      .map(({ line, number }) => `${relative}:${number}: ${line}`);
    expect(found).toEqual([]);
  });

  it.for(REAP_PATH_SOURCES)('%s neither passes an undefined signal nor drops a missing one', (relative) => {
    expect(read(relative)).not.toMatch(/signal: undefined|signal === undefined \? \{\} : \{ signal \}/);
  });
});
