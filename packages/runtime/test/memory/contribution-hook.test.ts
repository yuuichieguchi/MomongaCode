import { describe, expect, it } from 'vitest';
import { WORKING_FACTS_KEPT } from '@momonga/protocol';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import type { Run } from '@momonga/store';
import { contributionAtTerminal } from '@momonga/runtime';
import { functionCallItem } from '../worker/scripts.ts';

const journal = (payloads: readonly RunEventPayload[]): RunEvent[] =>
  payloads.map((payload, index) => ({ ...payload, id: index + 1, runId: 'run-w', sessionId: 's', seq: index + 1, step: 1, leaseToken: 1, createdAt: 1 }) as RunEvent);

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

const said = (text: string): RunEventPayload =>
  ({
    type: 'model.responded',
    step: 1,
    attempt: 1,
    response: { status: 'completed', output: [{ type: 'message', id: 'm', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], usage },
  }) as RunEventPayload;

const user = (text = 'Fix it'): RunEventPayload => ({ type: 'user.message', text });

const compactedThrough = (replacedThroughSeq: number): RunEventPayload => ({ type: 'context.compacted', item: { type: 'message', role: 'user', content: 's' }, summary: 'nothing', replacedThroughSeq });

const toolRun = (
  callId: string,
  name: string,
  args: Record<string, unknown>,
  output: string,
  status: 'completed' | 'failed' = 'completed',
  facts: Record<string, unknown> = {},
): RunEventPayload[] => [
  { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [functionCallItem({ callId, name, args })], usage } } as RunEventPayload,
  { type: 'tool.call', callId, providerCallId: callId, name, kind: 'other', title: name, rawInput: args },
  { type: 'tool.completed', callId, status, output, ...(status === 'failed' ? { exitCode: 1 } : {}), ...facts } as RunEventPayload,
];

const SHA256 = 'a'.repeat(64);

const writeFacts = (path: string): Record<string, unknown> => ({ files: [{ path, sha256: SHA256, access: 'write' }] });

const wrote = (callId: string, path: string): RunEventPayload[] => toolRun(callId, 'Write', { file_path: path, content: 'x' }, 'done', 'completed', writeFacts(path));

const wroteMany = (callId: string, paths: readonly string[]): RunEventPayload[] => {
  const [responded, call, completed] = toolRun(callId, 'MultiWrite', { count: paths.length }, 'done');
  return [responded as RunEventPayload, call as RunEventPayload, { ...(completed as RunEventPayload), files: paths.map((path) => ({ path, sha256: SHA256, access: 'write' as const })) } as RunEventPayload];
};

const trimmingPaths = Array.from({ length: WORKING_FACTS_KEPT }, (_unused, index) => `src/gen/trim${index}.ts`);

const found = (callId: string, path: string): RunEventPayload[] => toolRun(callId, 'Glob', { pattern: '*.ts' }, `found ${path}`);

const noRecord = { get: () => undefined };

const measure = (payloads: readonly RunEventPayload[], lookups: { memoryText?: string } = {}) => {
  const events = journal(payloads);
  return contributionAtTerminal.measure({
    run: { id: 'run-w' } as Run,
    events: events.filter((event) => contributionAtTerminal.eventTypes.includes(event.type)),
    replay: (visit) => {
      let state = initialRunState({ runId: 'run-w', sessionId: 's' });
      for (const event of events) {
        state = foldRunState(state, event);
        visit(state, event);
      }
    },
    memories: lookups.memoryText === undefined ? noRecord : { get: () => ({ text: lookups.memoryText }) as never },
    governing: noRecord,
  });
};

const workingStateOf = (result: ReturnType<typeof measure>): unknown => result?.items.filter((item) => item.kind === 'working_state');

describe('working state at terminal', () => {
  it('credits the working state when a step after the compaction names a written path whose record was replaced', () => {
    const result = measure([user(), ...toolRun('c0', 'Write', { file_path: 'src/launcher/zorp.ts', content: 'x' }, 'wrote src/launcher/zorp.ts', 'completed', writeFacts('src/launcher/zorp.ts')), compactedThrough(3), said('Editing src/launcher/zorp.ts again')]);
    expect(result?.items).toContainEqual({ kind: 'working_state', id: 'working-state', contributed: true });
    expect(result?.items).toContainEqual({ kind: 'summary', id: 'summary-5', contributed: false });
  });

  it('credits the working state for a failed command named again', () => {
    const result = measure([user(), ...toolRun('c0', 'Bash', { command: 'npm run buildZorp' }, 'npm run buildZorp failed', 'failed', { command: 'npm run buildZorp', files: [] }), compactedThrough(3), said('Retry buildZorp')]);
    expect(result?.items).toContainEqual({ kind: 'working_state', id: 'working-state', contributed: true });
  });

  it('gives nothing when the identifier is still in the retained history', () => {
    const result = measure([user(), compactedThrough(1), ...wrote('c1', 'src/launcher/zorp.ts'), said('src/launcher/zorp.ts')]);
    expect(result?.items).toContainEqual({ kind: 'working_state', id: 'working-state', contributed: false });
  });

  it('measures no working state without a compaction', () => {
    const result = measure([user(), said('src/launcher/zorp.ts')]);
    expect(result).toBeUndefined();
  });

  it('reports the working state once and uncredited when the compaction came with no facts', () => {
    const result = measure([user(), compactedThrough(1), said('src/launcher/zorp.ts')]);
    expect(workingStateOf(result)).toEqual([{ kind: 'working_state', id: 'working-state', contributed: false }]);
  });

  it('does not credit a path that the model wrote for the first time after the compaction', () => {
    const result = measure([user(), compactedThrough(1), ...wrote('c1', 'src/brandnew.ts')]);
    expect(workingStateOf(result)).toEqual([{ kind: 'working_state', id: 'working-state', contributed: false }]);
  });

  it('does not credit the step that issues the write which records the fact', () => {
    const result = measure([user(), ...found('c0', 'src/gen/zorp.ts'), compactedThrough(3), ...wrote('c1', 'src/gen/zorp.ts')]);
    expect(workingStateOf(result)).toEqual([{ kind: 'working_state', id: 'working-state', contributed: false }]);
  });

  it('credits the path of that write once a later compaction replaced its record and a step names it again', () => {
    const result = measure([user(), ...found('c0', 'src/gen/zorp.ts'), compactedThrough(3), ...wrote('c1', 'src/gen/zorp.ts'), compactedThrough(5), said('src/gen/zorp.ts again')]);
    expect(workingStateOf(result)).toEqual([{ kind: 'working_state', id: 'working-state', contributed: true }]);
  });

  it('credits a step that named a path while an earlier record of it was shown, though a later write replaced the record', () => {
    const result = measure([user(), ...found('c0', 'src/gen/zorp.ts'), ...wrote('c1', 'src/gen/zorp.ts'), compactedThrough(5), said('src/gen/zorp.ts'), ...wrote('c2', 'src/gen/zorp.ts')]);
    expect(workingStateOf(result)).toEqual([{ kind: 'working_state', id: 'working-state', contributed: true }]);
  });

  it('credits a step that named a path while its fact was shown, though newer facts trimmed it before the end of the run', () => {
    const result = measure([user(), ...found('c0', 'src/gen/zorp.ts'), ...wrote('c1', 'src/gen/zorp.ts'), compactedThrough(5), said('src/gen/zorp.ts'), ...wroteMany('bulk', trimmingPaths)]);
    expect(workingStateOf(result)).toEqual([{ kind: 'working_state', id: 'working-state', contributed: true }]);
  });

  it('does not credit a step that comes after the fact was trimmed', () => {
    const result = measure([user(), ...found('c0', 'src/gen/zorp.ts'), ...wrote('c1', 'src/gen/zorp.ts'), compactedThrough(5), ...wroteMany('bulk', trimmingPaths), compactedThrough(7), said('src/gen/zorp.ts')]);
    expect(workingStateOf(result)).toEqual([{ kind: 'working_state', id: 'working-state', contributed: false }]);
  });

  it('counts the working state rendered at the compaction as on screen for a memory injected after it', () => {
    const payloads: RunEventPayload[] = [
      user(),
      ...found('c0', 'src/gen/zorp.ts'),
      ...wrote('c1', 'src/gen/zorp.ts'),
      compactedThrough(5),
      { type: 'context.memories_loaded', memories: [{ id: 'm1', status: 'unbound' }] },
      said('src/gen/zorp.ts'),
    ];
    const result = measure(payloads, { memoryText: 'see src/gen/zorp.ts' });
    expect(result?.items).toContainEqual({ kind: 'memory', id: 'm1', contributed: false });
    expect(workingStateOf(result)).toEqual([{ kind: 'working_state', id: 'working-state', contributed: true }]);
  });
});
