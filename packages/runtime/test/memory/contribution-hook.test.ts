import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { initialRunState } from '@momonga/store';
import type { Run } from '@momonga/store';
import { contributionAtTerminal } from '@momonga/runtime';

const journal = (payloads: readonly RunEventPayload[]): RunEvent[] =>
  payloads.map((payload, index) => ({ ...payload, id: index + 1, runId: 'run-w', sessionId: 's', seq: index + 1, step: 1, leaseToken: 1, createdAt: 1 }) as RunEvent);

const said = (text: string): RunEventPayload =>
  ({
    type: 'model.responded',
    step: 1,
    attempt: 1,
    response: { status: 'completed', output: [{ type: 'message', id: 'm', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  }) as RunEventPayload;

const compacted: RunEventPayload = { type: 'context.compacted', item: { type: 'message', role: 'user', content: 's' }, summary: 'nothing', replacedThroughSeq: 2 };

const measure = (payloads: readonly RunEventPayload[]) => {
  const state = initialRunState({ runId: 'run-w', sessionId: 's' });
  const withFacts = {
    ...state,
    workingFacts: {
      ...state.workingFacts,
      written: [{ path: 'src/launcher/zorp.ts', seq: 2 }],
      commands: [{ command: 'npm run buildZorp', failed: true, exitCode: 1, seq: 2 }],
    },
  };
  return contributionAtTerminal.measure({
    run: { id: 'run-w' } as Run,
    events: journal(payloads),
    state: () => withFacts,
    memories: { get: () => undefined },
    governing: { get: () => undefined },
  });
};

describe('working state at terminal', () => {
  it('credits the working state when a step after the compaction names a written path whose record was replaced', () => {
    const result = measure([{ type: 'user.message', text: 'Fix it' }, { type: 'tool.completed', callId: 'c0', status: 'completed', output: 'wrote src/launcher/zorp.ts' }, compacted, said('Editing src/launcher/zorp.ts again')]);
    expect(result?.items).toContainEqual({ kind: 'working_state', id: 'working-state', contributed: true });
    expect(result?.items).toContainEqual({ kind: 'summary', id: 'summary-3', contributed: false });
  });

  it('credits the working state for a failed command named again', () => {
    const result = measure([{ type: 'user.message', text: 'Fix it' }, { type: 'tool.completed', callId: 'c0', status: 'failed', output: 'npm run buildZorp failed' }, compacted, said('Retry buildZorp')]);
    expect(result?.items).toContainEqual({ kind: 'working_state', id: 'working-state', contributed: true });
  });

  it('gives nothing when the identifier is still in the retained history', () => {
    const retained = measure([{ type: 'user.message', text: 'Fix it' }, compacted, { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'src/launcher/zorp.ts' }, said('src/launcher/zorp.ts')]);
    expect(retained?.items).toContainEqual({ kind: 'working_state', id: 'working-state', contributed: false });
  });

  it('measures no working state without a compaction', () => {
    const result = measure([{ type: 'user.message', text: 'Fix it' }, said('src/launcher/zorp.ts')]);
    expect(result).toBeUndefined();
  });
});
