import { describe, expect, it } from 'vitest';
import { GATE_FORMAT, GATE_RECORD_FILE, gateDecisionOf } from './gate-once.ts';
import type { GateRecord } from './gate-once.ts';
import { WHOLE_RUN_ENV } from './whole-run-guard.ts';

const PROJECTS = ['unit', 'calibration', 'packaging', 'e2e'];
const RECORD_PATH = `/repo/.git/${GATE_RECORD_FILE}`;
const GATE_HEAD = 'a'.repeat(40);
const EARLIER_HEAD = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const NOW = new Date('2026-11-18T10:00:00.000Z');
const WHOLE = { [WHOLE_RUN_ENV]: '1' };

const openGate = (wholeRuns: GateRecord['wholeRuns'] = {}): string => JSON.stringify({ format: GATE_FORMAT, head: GATE_HEAD, openedAt: '2026-11-18T09:00:00.000Z', wholeRuns });

const decide = (argv: readonly string[], recordText: string | undefined, env: Readonly<Record<string, string | undefined>> = WHOLE) =>
  gateDecisionOf({ argv, env, projects: PROJECTS, recordPath: RECORD_PATH, recordText, head: HEAD, now: NOW });

const refusalOf = (decision: ReturnType<typeof decide>): string => (decision.kind === 'refused' ? decision.message : '');

describe('one whole run per gate', () => {
  it('names the record file and its format', () => {
    expect(GATE_RECORD_FILE).toBe('momonga-gate.json');
    expect(GATE_FORMAT).toBe('momonga-gate/1');
  });

  it('leaves a whole run unchanged when no gate is open', () => {
    expect(decide(['node', 'vitest.mjs', 'run', '--project', 'unit'], undefined)).toEqual({ kind: 'unchanged' });
  });

  it('records the first whole run of a project with the current head and time', () => {
    const decision = decide(['node', 'vitest.mjs', 'run', '--project', 'unit'], openGate());
    expect(decision).toEqual({
      kind: 'record',
      record: { format: GATE_FORMAT, head: GATE_HEAD, openedAt: '2026-11-18T09:00:00.000Z', wholeRuns: { unit: { head: HEAD, startedAt: '2026-11-18T10:00:00.000Z' } } },
    });
  });

  it('keeps earlier whole runs of other projects when recording a new one', () => {
    const decision = decide(['node', 'vitest.mjs', 'run', '--project=e2e'], openGate({ unit: { head: EARLIER_HEAD, startedAt: '2026-11-18T09:30:00.000Z' } }));
    expect(decision).toEqual({
      kind: 'record',
      record: {
        format: GATE_FORMAT,
        head: GATE_HEAD,
        openedAt: '2026-11-18T09:00:00.000Z',
        wholeRuns: { unit: { head: EARLIER_HEAD, startedAt: '2026-11-18T09:30:00.000Z' }, e2e: { head: HEAD, startedAt: '2026-11-18T10:00:00.000Z' } },
      },
    });
  });

  it('records every whole-run project of a run that names no project', () => {
    const decision = decide(['node', 'vitest.mjs', 'run'], openGate());
    const runs = decision.kind === 'record' ? decision.record.wholeRuns : {};
    expect(Object.keys(runs).sort()).toEqual(['e2e', 'packaging', 'unit']);
    expect(runs['packaging']).toEqual({ head: HEAD, startedAt: '2026-11-18T10:00:00.000Z' });
  });

  it('refuses a second whole run of the same project, naming the earlier run, the gate head and the way to name files', () => {
    const decision = decide(['node', 'vitest.mjs', 'run', '--project', 'unit'], openGate({ unit: { head: EARLIER_HEAD, startedAt: '2026-11-18T09:30:00.000Z' } }));
    expect(decision.kind).toBe('refused');
    const message = refusalOf(decision);
    expect(message.startsWith('run-lock:')).toBe(true);
    expect(message).toContain('unit');
    expect(message).toContain(EARLIER_HEAD);
    expect(message).toContain('2026-11-18T09:30:00.000Z');
    expect(message).toContain(GATE_HEAD);
    expect(message).toContain('vitest run --project unit <file>');
  });

  it('refuses the second whole run even when the head has not moved', () => {
    const decision = decide(['node', 'vitest.mjs', 'run', '--project', 'unit'], openGate({ unit: { head: HEAD, startedAt: '2026-11-18T09:30:00.000Z' } }));
    expect(decision.kind).toBe('refused');
  });

  it('refuses a whole run of several projects when one already ran, and records none of them', () => {
    const decision = decide(['node', 'vitest.mjs', 'run', '--project', 'unit', '--project', 'e2e'], openGate({ e2e: { head: EARLIER_HEAD, startedAt: '2026-11-18T09:30:00.000Z' } }));
    expect(decision.kind).toBe('refused');
    const message = refusalOf(decision);
    expect(message).toContain('e2e');
    expect(message).toContain('vitest run --project e2e <file>');
  });

  it('neither refuses nor records a run that names test files', () => {
    const argv = ['node', 'vitest.mjs', 'run', '--project', 'unit', 'test/support/gate-once.test.ts'];
    expect(decide(argv, openGate({ unit: { head: EARLIER_HEAD, startedAt: '2026-11-18T09:30:00.000Z' } }))).toEqual({ kind: 'unchanged' });
    expect(decide(argv, openGate())).toEqual({ kind: 'unchanged' });
  });

  it('leaves a run that is not a whole run unchanged', () => {
    expect(decide(['node', 'vitest.mjs', 'run', '--project', 'calibration'], openGate())).toEqual({ kind: 'unchanged' });
    expect(decide(['node', 'vitest.mjs', 'run', '--project', 'unit'], openGate(), {})).toEqual({ kind: 'unchanged' });
  });

  it('refuses a whole run when the record cannot be parsed, naming the file', () => {
    const decision = decide(['node', 'vitest.mjs', 'run', '--project', 'unit'], '{not json');
    expect(decision.kind).toBe('refused');
    expect(refusalOf(decision).startsWith('run-lock:')).toBe(true);
    expect(refusalOf(decision)).toContain(RECORD_PATH);
  });

  it('refuses a whole run when the record has another format, naming the file', () => {
    const decision = decide(['node', 'vitest.mjs', 'run', '--project', 'unit'], JSON.stringify({ format: 'momonga-gate/2', head: GATE_HEAD, openedAt: '2026-11-18T09:00:00.000Z', wholeRuns: {} }));
    expect(decision.kind).toBe('refused');
    expect(refusalOf(decision)).toContain(RECORD_PATH);
  });
});
