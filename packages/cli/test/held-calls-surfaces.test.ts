import { describe, expect, it } from 'vitest';
import { createMapperState, mapRunEvent } from '../src/acp/events.ts';
import type { ClientFeatures } from '../src/acp/events.ts';
import { approvalLines } from '../src/tui/screen/prompt-panel.tsx';
import { HELD_PANEL_LINE, QUIESCENT_PHASE_TEXT, blockingPrompt, shownRunPhase } from '../src/tui/transcript.ts';
import { frameOf } from './acp-harness.ts';
import type { EventPayload } from './acp-harness.ts';
import { fold, storeOf } from './tui/screen-fakes.ts';

const REASON = 'PullRequestMerge always needs a person to approve';
const HELD_TEXT = 'Not run yet: waiting for a person to approve (ap-1).';

const call = { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'PullRequestMerge', kind: 'other', title: 'Merge pull request #7', rawInput: { number: 7 } };
const other = { type: 'tool.call', callId: 'c2', providerCallId: 'p2', name: 'Bash', kind: 'execute', title: 'Bash cat out.txt', rawInput: { command: 'cat out.txt' } };
const requested = { type: 'tool.permission.requested', approvalId: 'ap-1', callId: 'c1', subjectDigest: 'd', options: [{ optionId: 'o', name: 'Allow once', kind: 'allow_once' }], reason: REASON };
const held = { type: 'tool.held', callId: 'c1', approvalId: 'ap-1', reason: REASON, footprint: { reads: [], writes: ['pr:forge.example/acme/widgets#7'] } };
const placeholder = { type: 'tool.completed', callId: 'c1', status: 'failed', output: HELD_TEXT, denial: { source: 'held', reason: REASON } };
const blocked = { type: 'tool.completed', callId: 'c2', status: 'failed', output: 'Not run: blocked by the held call c1', denial: { source: 'held', reason: 'Not run: blocked by the held call c1' } };
const modelRequested = { type: 'model.requested', step: 2, attempt: 1, digest: 'd' };
const quiescent = { type: 'run.quiescent', held: [{ callId: 'c1', approvalId: 'ap-1', tool: 'PullRequestMerge', reason: REASON, sinceSeq: 3 }] };
const resolved = { type: 'tool.permission.resolved', approvalId: 'ap-1', optionId: 'o' };
const executed = { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'Pull request #7 is merged.', held: { approvalId: 'ap-1' } };
const rejected = { type: 'tool.held.resolved', callId: 'c1', approvalId: 'ap-1', outcome: 'rejected', status: 'failed', output: 'A person rejected this call, so it was not run.' };

describe('a held call in the TUI', () => {
  it('stays in the approval panel as a held approval, and its tool row keeps waiting for approval instead of failing', () => {
    const state = fold([call, requested, held, placeholder]);
    expect(state.approval).toMatchObject({ approvalId: 'ap-1', callId: 'c1', held: true });
    expect(state.entries[0]).toMatchObject({ kind: 'tool', status: 'awaiting_approval' });
    expect(state.entries[0]).not.toHaveProperty('denial');
  });

  it('says in the panel that the run goes on while the call waits', () => {
    const state = fold([call, requested, held, placeholder]);
    if (state.approval === undefined) throw new Error('no approval is pending');
    expect(approvalLines(state.approval, undefined, '/work')).toEqual([REASON, HELD_PANEL_LINE]);
    expect(approvalLines({ ...state.approval, held: undefined } as never, undefined, '/work')).toEqual([REASON]);
  });

  it('keeps the waiting row while the run works on, and names the held calls in it', () => {
    const state = fold([call, requested, held, placeholder, modelRequested]);
    expect(blockingPrompt(state)).toBe(false);
    expect(shownRunPhase(state)?.text).toBe('waiting for the model · 1 call held for your approval');
  });

  it('says in the waiting row that nothing else can proceed when the run is quiescent', () => {
    const state = fold([call, requested, held, placeholder, modelRequested, quiescent]);
    expect(shownRunPhase(state)?.text).toBe(`${QUIESCENT_PHASE_TEXT} · 1 call held for your approval`);
  });

  it('hides the waiting row for an approval that blocks the run, as before', () => {
    const state = fold([call, requested, modelRequested]);
    expect(blockingPrompt(state)).toBe(true);
    expect(shownRunPhase(state)).toBeUndefined();
  });

  it('shows the late result on the tool row when the approved call has run, and the refusal when a person rejected it', () => {
    const ran = fold([call, requested, held, placeholder, resolved, executed]);
    expect(ran.approval).toBeUndefined();
    expect(ran.entries[0]).toMatchObject({ kind: 'tool', status: 'completed', output: 'Pull request #7 is merged.' });
    const refused = fold([call, requested, held, placeholder, resolved, rejected]);
    expect(refused.entries[0]).toMatchObject({ kind: 'tool', status: 'failed', output: 'A person rejected this call, so it was not run.' });
  });

  it('shows a call blocked by a held call as failed with its reason', () => {
    const store = storeOf([call, requested, held, placeholder, other, blocked]);
    expect(fold([call, requested, held, placeholder, other, blocked]).entries[1]).toMatchObject({ kind: 'tool', status: 'failed', denial: { source: 'held' } });
    expect(store.state().approval).toMatchObject({ held: true });
  });
});

const FEATURES: ClientFeatures = { notices: true, compaction: false, elicitation: { form: false, url: false } };

const acp = (payloads: readonly Record<string, unknown>[]) => {
  const state = createMapperState();
  return payloads.map((payload, index) => mapRunEvent(frameOf('run-1', index + 1, payload as EventPayload).data, 'live', state, FEATURES));
};

const text = (value: string) => [{ type: 'content', content: { type: 'text', text: value } }];

describe('a held call over ACP', () => {
  it('stays pending with the reason while it waits, through its hold and its placeholder result', () => {
    const effects = acp([call, requested, held, placeholder]);
    expect(effects[1]).toEqual([expect.objectContaining({ kind: 'permission', approvalId: 'ap-1' })]);
    const update = { sessionUpdate: 'tool_call_update', toolCallId: 'run-1/c1', status: 'pending', content: text(`Held for approval (ap-1): ${REASON}. The run goes on with other work.`) };
    expect(effects[2]).toEqual([{ kind: 'update', update }]);
    expect(effects[3]).toEqual([{ kind: 'update', update }]);
  });

  it('reports the late result of the approved call as its completion, and a rejected call as failed', () => {
    expect(acp([call, requested, held, placeholder, resolved, executed])[5]).toEqual([
      { kind: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'run-1/c1', status: 'completed', content: text('Pull request #7 is merged.'), rawOutput: 'Pull request #7 is merged.' } },
    ]);
    expect(acp([call, requested, held, placeholder, resolved, rejected])[5]).toEqual([
      {
        kind: 'update',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'run-1/c1', status: 'failed', content: text('A person rejected this call, so it was not run.'), rawOutput: 'A person rejected this call, so it was not run.' },
      },
    ]);
  });

  it('reports a call blocked by a held call as failed', () => {
    const effects = acp([call, requested, held, placeholder, other, blocked]);
    expect(effects[5]).toEqual([expect.objectContaining({ update: expect.objectContaining({ toolCallId: 'run-1/c2', status: 'failed' }) })]);
  });

  it('says on each held call that the run waits for a person when the run is quiescent', () => {
    expect(acp([call, requested, held, placeholder, quiescent])[4]).toEqual([
      {
        kind: 'update',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'run-1/c1', status: 'pending', content: text(`Held for approval (ap-1): ${REASON}. The run waits for a person: nothing else can proceed.`) },
      },
    ]);
  });
});
