import { describe, expect, it } from 'vitest';
import type { MomongaModelEntry, ToolCallingState } from '@momonga/protocol';
import { followMeasurement } from '../../src/readiness.ts';
import { describeRetryWait } from '../../src/retry-wait.ts';
import { rowsOfEntry } from '../../src/tui/screen/entry-rows.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import { subagentLines } from '../../src/tui/screen/subagents.tsx';
import { waitingOf, waitingRowText } from '../../src/tui/screen/waiting-row.tsx';
import type { WaitingFacts } from '../../src/tui/screen/waiting-row.tsx';
import { runCreated, runLeft, setThoughtWindow, shownRunPhase, toggleNewestThought, toggleThought } from '../../src/tui/transcript.ts';
import { capabilitiesOf } from '../fake-backend.ts';
import { manualClock } from './screen-clock.ts';
import { fold, plainOf, storeOf } from './screen-fakes.ts';

const at = (createdAt: number, event: Record<string, unknown>): Record<string, unknown> => ({ ...event, createdAt });

const call = (callId: string, title: string) => ({ type: 'tool.call', callId, providerCallId: `p-${callId}`, name: 'Bash', kind: 'execute', title, rawInput: {} });
const completed = (callId: string) => ({ type: 'tool.completed', callId, status: 'completed', output: '' });
const requested = { type: 'model.requested', attempt: 0, digest: 'd' };
const thought = (text: string, itemId = 't1') => ({ type: 'agent.thought.delta', attempt: 0, itemId, text });
const message = (text: string, itemId = 'm1') => ({ type: 'agent.message.delta', attempt: 0, itemId, text });
const responded = (target?: string) => ({ type: 'model.responded', attempt: 0, response: { usage: { total_tokens: 10 } }, ...(target === undefined ? {} : { target }) });
const status = (from: string, to: string) => ({ type: 'run.status', from, to });
const failed = { type: 'attempt.failed', attempt: 3, code: 'provider_unavailable', retryAt: 60_000, limit: 20 };

const phaseAfter = (events: readonly Record<string, unknown>[]) => fold(events).phase;

describe('the phase of a run comes from its events (6.1)', () => {
  it('names each wait by the event that starts it and takes its start from that event', () => {
    expect(phaseAfter([at(7000, requested)])).toEqual({ kind: 'model', text: 'waiting for the model', startedAt: 7000 });
    expect(phaseAfter([requested, at(8000, { type: 'model.stream.restarted', attempt: 0 })])).toMatchObject({ text: 'waiting for the model', startedAt: 8000 });
    expect(phaseAfter([requested, at(2000, thought('a')), at(3000, thought('b'))])).toMatchObject({ text: 'thinking', startedAt: 2000 });
    expect(phaseAfter([requested, thought('a'), at(4000, message('x')), at(5000, message('y'))])).toMatchObject({ text: 'responding', startedAt: 4000 });
    expect(phaseAfter([at(100, call('c1', 'Bash ls'))])).toMatchObject({ text: 'running Bash ls', startedAt: 100 });
    expect(phaseAfter([{ type: 'tool.permission.classifying', callId: 'c1', subjectDigest: 'd' }])?.text).toBe('checking this call');
    expect(phaseAfter([{ type: 'hook.started', event: 'PreToolUse', command: 'check.sh' }])?.text).toBe('running hook PreToolUse');
    expect(phaseAfter([{ type: 'context.compacting', attempt: 0 }])?.text).toBe('compacting the conversation');
    expect(phaseAfter([{ type: 'tool.waiting', callId: 'c1', awaits: { kind: 'job', jobId: 'bash_1' } }])?.text).toBe('waiting for job bash_1');
    expect(phaseAfter([{ type: 'tool.waiting', callId: 'c1', awaits: { kind: 'run', runId: 'x', sessionId: 's', agent: 'reviewer' } }])?.text).toBe('waiting for subagent reviewer');
    expect(phaseAfter([status('RUNNING', 'QUEUED')])?.text).toBe('waiting for the model');
  });

  it('shows the newest of several running tools and how many more run', () => {
    const three = [at(1, call('c1', 'Bash ls')), at(2, call('c2', 'Read /a')), at(3, call('c3', 'Read /b'))];
    expect(phaseAfter(three)).toMatchObject({ text: 'running Read /b +2', startedAt: 3 });
    expect(phaseAfter([...three, completed('c3')])).toMatchObject({ text: 'running Read /a +1', startedAt: 2 });
    expect(phaseAfter([...three, completed('c3'), completed('c2'), { type: 'tool.reconciled', callId: 'c1', outcome: 'unknown', output: '' }])).toBeUndefined();
  });

  it('ends each wait at the event that ends it', () => {
    expect(phaseAfter([requested, responded()])).toBeUndefined();
    expect(phaseAfter([requested, { type: 'model.rejected', attempt: 0, reason: 'refused' }])).toBeUndefined();
    expect(phaseAfter([call('c1', 'Bash ls'), { type: 'tool.permission.classifying', callId: 'c1', subjectDigest: 'd' }, { type: 'tool.permission.classified', callId: 'c1', subjectDigest: 'd', decision: 'allow', reason: 'safe' }])?.text).toBe(
      'running Bash ls',
    );
    expect(phaseAfter([{ type: 'hook.started', event: 'Stop', command: 'x' }, { type: 'hook.completed', hookEvent: 'Stop', command: 'x', outcome: 'success' }])).toBeUndefined();
    expect(phaseAfter([{ type: 'context.compacting', attempt: 0 }, { type: 'context.compacted' }])).toBeUndefined();
    expect(phaseAfter([{ type: 'context.compacting', attempt: 0 }, { type: 'context.compaction_rejected', item: {} }])).toBeUndefined();
    expect(phaseAfter([{ type: 'tool.waiting', callId: 'c1', awaits: { kind: 'job', jobId: 'j' } }, status('RUNNING', 'WAITING_TOOL'), status('WAITING_TOOL', 'RUNNING')])).toBeUndefined();
    expect(phaseAfter([requested, call('c1', 'Bash ls'), failed])).toBeUndefined();
    expect(phaseAfter([requested, { type: 'attempt.lost', lastLiveAt: 1 }])).toBeUndefined();
    for (const end of ['COMPLETED', 'FAILED', 'CANCELLED']) expect(phaseAfter([requested, call('c1', 'Bash ls'), status('RUNNING', end)])).toBeUndefined();
  });

  it('shows the retry wait as the phase only, with the text of the headless path, and writes no entry for it', () => {
    const waiting = fold([failed, at(9000, status('RUNNING', 'QUEUED'))]);
    expect(waiting.phase).toEqual({ kind: 'retry', text: describeRetryWait({ code: 'provider_unavailable', attempt: 3, limit: 20, retryAt: 60_000 }), startedAt: 9000 });
    expect(waiting.phase?.text).toMatch(/^Waiting to reach the provider \(attempt 3 of 20\)\. Retrying at \d\d:\d\d:\d\d\.$/);
    expect(waiting.entries).toEqual([]);
    expect(fold([failed, status('RUNNING', 'QUEUED'), status('QUEUED', 'RUNNING'), status('RUNNING', 'QUEUED')]).phase?.text).toBe('waiting for the model');
  });

  it('hides the phase while an approval or an MCP input is open, and a child run never changes it', () => {
    const store = storeOf([requested, call('c1', 'Bash ls'), { type: 'tool.permission.requested', approvalId: 'ap', callId: 'c1', subjectDigest: 'd', options: [], reason: 'ask' }]);
    expect(shownRunPhase(store.state())).toBeUndefined();
    storeOf([{ type: 'tool.permission.resolved', approvalId: 'ap', optionId: 'o' }], store);
    expect(shownRunPhase(store.state())?.text).toBe('running Bash ls');
  });

  it('starts with the local wait of a created run and drops every phase when the run is left', () => {
    const store = createTranscriptStore();
    runCreated(store, 'run-1', 4000);
    expect(store.state()).toMatchObject({ runId: 'run-1', runStatus: 'QUEUED', phase: { text: 'waiting for the model', startedAt: 4000 } });
    storeOf([call('c1', 'Bash ls')], store);
    runLeft(store);
    expect(store.state().phase).toBeUndefined();
    expect(store.state().runningTools).toEqual([]);
  });
});

describe('the waiting row (6.1)', () => {
  const none: WaitingFacts = { startingSince: undefined, prompting: false, reconnectingSince: undefined, run: undefined, command: undefined, measuringSince: undefined, panelOwnsEscape: false };
  const run = { text: 'thinking', startedAt: 1000 };

  it('writes the spinner frame, the phase, the whole seconds and the key that cancels', () => {
    expect(waitingRowText({ phase: run, cancelKey: 'esc' }, 0, 1000)).toBe('⠋ thinking 0s · esc to cancel');
    expect(waitingRowText({ phase: run, cancelKey: 'esc' }, 3, 13_999)).toBe('⠸ thinking 12s · esc to cancel');
    expect(waitingRowText({ phase: run, cancelKey: 'ctrl+c' }, 10, 2000)).toBe('⠋ thinking 1s · ctrl+c to cancel');
    expect(waitingRowText({ phase: run, cancelKey: undefined }, 9, 500)).toBe('⠏ thinking 0s');
  });

  it('is absent without a phase and shows one phase at a time', () => {
    expect(waitingOf(none)).toBeUndefined();
    expect(waitingOf({ ...none, startingSince: 5, run })).toEqual({ phase: { text: 'starting the momonga daemon', startedAt: 5 }, cancelKey: 'ctrl+c' });
    expect(waitingOf({ ...none, reconnectingSince: 7, run })).toEqual({ phase: { text: 'reconnecting to the daemon', startedAt: 7 }, cancelKey: 'esc' });
    expect(waitingOf({ ...none, run, measuringSince: 3 })).toEqual({ phase: run, cancelKey: 'esc' });
    expect(waitingOf({ ...none, command: { text: 'running /gateway', startedAt: 9 } })).toEqual({ phase: { text: 'running /gateway', startedAt: 9 }, cancelKey: 'esc' });
    expect(waitingOf({ ...none, measuringSince: 3 })).toEqual({ phase: { text: 'measuring this model (once per model and OS build)', startedAt: 3 }, cancelKey: undefined });
  });

  it('names ctrl+c while a panel owns Esc and is hidden while an approval is open', () => {
    expect(waitingOf({ ...none, run, panelOwnsEscape: true })?.cancelKey).toBe('ctrl+c');
    expect(waitingOf({ ...none, run, measuringSince: 3, prompting: true })).toBeUndefined();
  });
});

describe('the thinking display (6.3)', () => {
  const texts = (store: ReturnType<typeof storeOf>, width = 40): string[] => rowsOfEntry(store.at(0).entry, width).map((row) => row.text);

  it('shows an open thought under its header with the last rows of its text and how many lie above', () => {
    const store = createTranscriptStore();
    setThoughtWindow(store, 2);
    storeOf([at(1000, thought('one\ntwo\n')), at(2000, thought('three\nfour'))], store);
    expect(plainOf(store).entries).toEqual([{ kind: 'thought', itemId: 't1', text: 'one\ntwo\nthree\nfour', startedAt: 1000, expanded: false, window: 2 }]);
    expect(texts(store)).toEqual(['Thinking', '… 2 earlier lines', 'three', 'four']);
    setThoughtWindow(store, 4);
    expect(texts(store)).toEqual(['Thinking', 'one', 'two', 'three', 'four']);
    expect(rowsOfEntry(store.at(0).entry, 40).every((row) => row.spans.some(([, , token]) => token === 'dim'))).toBe(true);
  });

  it('folds to one line with its seconds at the first answer text or tool call, and opens and folds again', () => {
    const answered = storeOf([at(1000, thought('why\nbecause')), at(13_400, message('so'))]);
    expect(texts(answered)).toEqual(['Thought for 12s']);
    expect(storeOf([at(1000, thought('why')), at(2600, call('c1', 'Bash ls'))]).at(0).entry).toMatchObject({ kind: 'thought', endedAt: 2600 });
    expect(texts(storeOf([at(1000, thought('why')), at(2600, call('c1', 'Bash ls'))]))).toEqual(['Thought for 2s']);
    toggleNewestThought(answered);
    expect(texts(answered)).toEqual(['Thought for 12s', 'why', 'because']);
    toggleThought(answered, 't1');
    expect(texts(answered)).toEqual(['Thought for 12s']);
  });

  it('toggles the newest thought only, closes an open thought when the run ends and shows none for a model that streams none', () => {
    const store = storeOf([at(0, thought('first', 't1')), at(1000, message('a', 'm1')), at(2000, thought('second', 't2')), at(5000, status('RUNNING', 'CANCELLED'))]);
    toggleNewestThought(store);
    expect(plainOf(store).entries.map((entry) => (entry.kind === 'thought' ? [entry.itemId, entry.expanded, entry.endedAt] : entry.kind))).toEqual([['t1', false, 1000], 'assistant', ['t2', true, 5000]]);
    expect(fold([requested, message('plain')]).entries.map((entry) => entry.kind)).toEqual(['assistant']);
  });

  it('escapes the thought as every model text', () => {
    const store = storeOf([thought('a\u001b[31mb'), at(1, message('x'))]);
    toggleNewestThought(store);
    expect(texts(store).join('\n')).not.toContain('\u001b');
  });
});

describe('the answering model (6.4)', () => {
  it('writes one entry when another model answers and none while the same one does', () => {
    expect(fold([responded('primary'), responded('primary')]).entries).toEqual([]);
    expect(fold([responded('primary'), responded(), responded('backup')]).entries).toEqual([{ kind: 'info', text: 'model changed: primary -> backup' }]);
  });
});

describe('the running subagents (3.3)', () => {
  const subagent = (index: number, extra: Partial<{ title: string; awaitingApproval: boolean }> = {}) => ({ runId: `r${index}`, agent: `agent${index}`, title: undefined, startedAt: 1000, awaitingApproval: false, ...extra });

  it('writes one row each: the agent, what it does and its seconds', () => {
    expect(subagentLines([subagent(1), subagent(2, { title: 'Read /b' }), subagent(3, { title: 'Bash ls', awaitingApproval: true })], 5, 13_500)).toEqual([
      'agent1 · starting · 12s',
      'agent2 · Read /b · 12s',
      'agent3 · waiting for approval · 12s',
    ]);
  });

  it('ends with the overflow row when there are more than fit', () => {
    expect(subagentLines([1, 2, 3, 4, 5].map((index) => subagent(index)), 3, 1000)).toEqual(['agent1 · starting · 0s', 'agent2 · starting · 0s', 'and 3 more']);
    expect(subagentLines([subagent(1)], 0, 1000)).toEqual([]);
  });
});

describe('the measuring poll (6.2)', () => {
  const entryOf = (toolCalling: ToolCallingState | undefined): MomongaModelEntry => {
    const capabilities = { ...capabilitiesOf(), ...(toolCalling === undefined ? {} : { toolCalling }) };
    return { id: 'default', object: 'model', targets: ['primary'], targetCounters: {}, capabilities, targetCapabilities: {} } as MomongaModelEntry;
  };
  const probing = (retryAfterSeconds: number): ToolCallingState => ({ state: 'probing', message: 'measuring', retryAfterSeconds });
  const unavailable: ToolCallingState = { state: 'unavailable', status: 503, type: 'server_error', code: 'target_probe_failed', message: 'measuring this model failed: no answer' };

  const poll = (answers: (ToolCallingState | undefined)[], first: number) => {
    const clock = manualClock();
    const reads: number[] = [];
    const settled: MomongaModelEntry[] = [];
    const stop = followMeasurement(
      {
        read: async () => {
          reads.push(clock.now());
          return entryOf(answers.shift());
        },
        timers: clock.timers,
      },
      first,
      (entry) => settled.push(entry),
      (error) => {
        throw error;
      },
    );
    return { clock, reads, settled, stop };
  };

  const turn = async (): Promise<void> => {
    for (let count = 0; count < 5; count += 1) await Promise.resolve();
  };

  it('reads again after the seconds the gateway reports, at least one, one read at a time, and stops at the first other answer', async () => {
    const { clock, reads, settled } = poll([probing(0), unavailable], 5);
    clock.advance(4999);
    expect(reads).toEqual([]);
    clock.advance(1);
    await turn();
    expect(reads).toEqual([5000]);
    expect(clock.pending()).toBe(1);
    clock.advance(1000);
    await turn();
    expect(reads).toEqual([5000, 6000]);
    expect(settled.map((entry) => entry.capabilities.toolCalling)).toEqual([unavailable]);
    expect(clock.pending()).toBe(0);
  });

  it('ends with nothing to say when the model is ready, and reads no more once stopped', async () => {
    const ready = poll([undefined], 2);
    ready.clock.advance(2000);
    await turn();
    expect(ready.settled).toHaveLength(1);
    expect(ready.clock.pending()).toBe(0);

    const stopped = poll([probing(1)], 2);
    stopped.stop();
    stopped.clock.advance(60_000);
    await turn();
    expect(stopped.reads).toEqual([]);
  });
});
