import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';

const STORE_SRC = fileURLToPath(new URL('../src/', import.meta.url));
const TOOL_NAME_LITERAL = /'(?:Bash|Write|Edit|Read|Glob|Grep)'/;

const IDS = { runId: 'run-effects', sessionId: 'session-effects' };
const USAGE = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

const fold = (payloads: readonly RunEventPayload[]): RunState =>
  payloads
    .map((payload, index) => ({ ...payload, id: index + 1, ...IDS, seq: index + 1, step: 1, leaseToken: 1, createdAt: 1 }) as RunEvent)
    .reduce(foldRunState, initialRunState(IDS));

const called = (callId: string, name: string, rawInput: unknown): RunEventPayload[] => [
  {
    type: 'model.responded',
    step: 1,
    attempt: 1,
    response: { status: 'completed', output: [{ type: 'function_call', call_id: callId, name, arguments: JSON.stringify(rawInput) }], usage: USAGE },
  },
  { type: 'tool.call', callId, providerCallId: callId, name, kind: 'other', title: name, rawInput },
];

const completed = (callId: string, fields: Record<string, unknown>): RunEventPayload =>
  ({ type: 'tool.completed', callId, status: 'completed', output: 'ok', ...fields }) as RunEventPayload;

const H = sha256Hex('new content');

describe('the fold reads event data only', () => {
  it('yields a command fact from command and exitCode on a call of a tool named Sh', () => {
    const state = fold([...called('c1', 'Sh', { script: 'anything' }), completed('c1', { command: 'sed -i s/a/b/ f.ts', exitCode: 0, files: [] })]);
    expect(state.workingFacts.commands).toEqual([{ command: 'sed -i s/a/b/ f.ts', failed: false, exitCode: 0, seq: 3 }]);
  });

  it('yields written facts from files on a call of a tool named Anything', () => {
    const state = fold([...called('c1', 'Anything', {}), completed('c1', { files: [{ path: '/p/a.ts', sha256: H, access: 'write' }] })]);
    expect(state.workingFacts.written).toEqual([{ path: '/p/a.ts', sha256: H, seq: 3 }]);
  });

  it('yields a removed fact from a remove entry, with no hash', () => {
    const state = fold([...called('c1', 'Sh', {}), completed('c1', { command: 'rm old.ts', exitCode: 0, files: [{ path: '/p/old.ts', access: 'remove' }] })]);
    expect(state.workingFacts.written).toEqual([{ path: '/p/old.ts', removed: true, seq: 3 }]);
  });

  it('derives no written fact from the file_path argument of a Write whose event has no files', () => {
    const state = fold([...called('c1', 'Write', { file_path: '/p/old.ts', content: 'x' }), completed('c1', {})]);
    expect(state.workingFacts.written).toEqual([]);
  });

  it('derives no command fact from the command argument of a Bash call whose event has no command', () => {
    const state = fold([...called('c1', 'Bash', { command: 'make lint' }), completed('c1', { exitCode: 0 })]);
    expect(state.workingFacts.commands).toEqual([]);
  });

  it('marks a command fact unobserved when files is absent', () => {
    const state = fold([...called('c1', 'Sh', {}), completed('c1', { command: 'make fmt', exitCode: 0 })]);
    expect(state.workingFacts.commands).toEqual([{ command: 'make fmt', failed: false, exitCode: 0, unobserved: true, seq: 3 }]);
  });

  it('keeps windowShared on the command fact', () => {
    const state = fold([...called('c1', 'Sh', {}), completed('c1', { command: 'make fmt', exitCode: 0, files: [], windowShared: true })]);
    expect(state.workingFacts.commands).toEqual([{ command: 'make fmt', failed: false, exitCode: 0, windowShared: true, seq: 3 }]);
  });

  it('yields a reconciled written fact and command from tool.reconciled data', () => {
    const state = fold([
      ...called('c1', 'Anything', {}),
      { type: 'tool.reconciled', callId: 'c1', outcome: 'already_applied', output: 'applied', files: [{ path: '/p/r.ts', access: 'write' }], command: 'gen --out r.ts' } as RunEventPayload,
    ]);
    expect(state.workingFacts.written).toEqual([{ path: '/p/r.ts', reconciled: 'already_applied', seq: 3 }]);
    expect(state.workingFacts.commands).toEqual([{ command: 'gen --out r.ts', failed: false, reconciled: 'already_applied', seq: 3 }]);
  });

  it('holds no tool-name branch in fold.ts', () => {
    const source = fs.readFileSync(path.join(STORE_SRC, 'fold.ts'), 'utf8');
    expect(source).not.toMatch(TOOL_NAME_LITERAL);
    expect(source).not.toMatch(/call\.name\s*===|\.includes\(call\.name\)/);
  });

  it('holds no tool-name branch in search-documents.ts', () => {
    const source = fs.readFileSync(path.join(STORE_SRC, 'search-documents.ts'), 'utf8');
    expect(source).not.toMatch(TOOL_NAME_LITERAL);
    expect(source).not.toMatch(/item\.name\s*===|\.includes\(item\.name\)/);
  });

  it('derives nothing from the arguments of a reconciled Write with no files', () => {
    const state = fold([...called('c1', 'Write', { file_path: '/p/w.ts', content: 'x' }), { type: 'tool.reconciled', callId: 'c1', outcome: 'unknown', output: '?' }]);
    expect(state.workingFacts.written).toEqual([]);
  });
});
