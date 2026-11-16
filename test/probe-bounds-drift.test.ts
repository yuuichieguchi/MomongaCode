import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
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

const forwardsOptionsOfItsCaller = (call: string, beforeCall: string): boolean =>
  [...call.matchAll(/\.\.\.(\w+)\b/g)].some(([, name = '']) => new RegExp(`\\([^()]*\\b${name}\\b[^()]*\\)\\s*=>\\s*$`).test(beforeCall));

const signalOf = (call: string, line: string, beforeCall: string): boolean => /\bsignal\b/.test(forwardsOptionsOfItsCaller(call, beforeCall) ? line : call);

const callsWithoutSignalIn = (relative: string, text: string): string[] => {
  const found: string[] = [];
  for (const match of text.matchAll(PROBE_CALL)) {
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const lineEnd = text.indexOf('\n', match.index);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    if (line.trim().startsWith('import') || line.includes('typeof ')) continue;
    const call = callTextFrom(text, match.index + match[0].length - 1);
    if (!signalOf(call, line, text.slice(lineStart, match.index))) found.push(`${relative}:${text.slice(0, match.index).split('\n').length}: ${line.trim()}`);
  }
  return found;
};

const callsWithoutSignal = (relative: string): string[] => callsWithoutSignalIn(relative, read(relative));

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

  it('reads a probe inside an arrow that spreads its options parameter as given the signal its caller passes on the same line', () => {
    expect(callsWithoutSignalIn('planted.ts', 'await ((pgid, options) => terminateGroup(pgid, { ...options, port }))(group, { signal: bound.signal });')).toEqual([]);
    expect(callsWithoutSignalIn('planted.ts', 'await ((pgid, options) => terminateGroup(pgid, { ...options, port }))(group, { graceMs });')).toHaveLength(1);
    expect(callsWithoutSignalIn('planted.ts', 'await terminateGroup(pgid, { ...defaults, port }); const signal = bound.signal;')).toHaveLength(1);
  });
});

describe('T12 no private probe number remains and the + 2000 margins are gone', () => {
  it('foundation exports no constant named *_PROBE_TIMEOUT_MS', () => {
    expect(Object.keys(foundation).filter((name) => name.endsWith('_PROBE_TIMEOUT_MS'))).toEqual([]);
  });

  it('no orphan reap grace of its own is exported: the reap of a daemon marker takes the one daemon marker kill grace', () => {
    expect('ORPHAN_REAP_GRACE_MS' in supervisor).toBe(false);
    expect('ORPHAN_REAP_GRACE_MS' in foundation).toBe(false);
    expect('orphanReapGraceMs' in foundation).toBe(false);
    expect(read('packages/supervisor/src/reaper-pass.ts')).toMatch(/orphanReapGraceMs: DAEMON_MARKER_KILL_GRACE_MS,/);
  });

  it('the orphan phase deadline and the default orphanGraceMs are runtimeMaxCloseMs of the predecessor values with no margin', () => {
    const orphans = read('packages/supervisor/src/orphans.ts');
    expect(orphans).not.toContain('PHASE_ONE_MARGIN_MS');
    expect(orphans).toMatch(/Math\.min\(\w+\.orphanGraceMs, runtimeMaxCloseMs\([^)]*\)\)/);
    expect(read('packages/supervisor/src/start-supervisor.ts')).not.toMatch(/orphanGraceMs|orphanReapGraceMs|runtimeMaxCloseMs\(/);
    expect(read('packages/supervisor/src/reaper-pass.ts')).toMatch(/orphanGraceMs: [^,\n]*\?\? runtimeMaxCloseMs\(MAXIMUM_STOP_VALUES\),/);
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
