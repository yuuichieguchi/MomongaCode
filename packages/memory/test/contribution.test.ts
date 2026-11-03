import { describe, expect, it } from 'vitest';
import { measureContribution, nextMemoryShare } from '@momonga/memory';
import type { ContributionWindowRun, InjectedItem } from '@momonga/memory';
import type { ContributionKind, RunEvent, RunEventPayload } from '@momonga/protocol';

const TASK = 'Fix the launcher';

const journal = (payloads: readonly RunEventPayload[]): RunEvent[] =>
  payloads.map((payload, index) => ({ ...payload, id: index + 1, runId: 'run-c', sessionId: 's', seq: index + 1, step: 1, leaseToken: 1, createdAt: 1 }) as RunEvent);

const said = (step: number, text: string): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output: [{ type: 'message', id: `m${step}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
} as RunEventPayload);

const called = (step: number, args: Record<string, unknown>): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output: [{ type: 'function_call', id: `f${step}`, call_id: `c${step}`, name: 'Read', arguments: JSON.stringify(args), status: 'completed' }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
} as RunEventPayload);

const toolOutput = (output: string): RunEventPayload => ({ type: 'tool.completed', callId: 'c0', status: 'completed', output });

const compaction = (replacedThroughSeq: number): RunEventPayload => ({ type: 'context.compacted', item: { type: 'message', role: 'user', content: 's' }, summary: 's', replacedThroughSeq });

const item = (text: string, overrides: Partial<InjectedItem> = {}): InjectedItem => ({ kind: 'memory', id: 'q1', text, fromSeq: 0, ...overrides });

const contributedOf = (payloads: readonly RunEventPayload[], injected: InjectedItem, task = TASK): boolean =>
  measureContribution({ events: journal(payloads), task, injected: [injected] })[0]?.contributed ?? false;

describe('measureContribution', () => {
  it('credits an item whose identifier first appears in a step text', () => {
    expect(measureContribution({ events: journal([said(1, 'Calling zorpLauncher now')]), task: TASK, injected: [item('use zorpLauncher')] })).toEqual([{ kind: 'memory', id: 'q1', contributed: true }]);
  });

  it('credits an identifier found in the arguments of a call', () => {
    expect(contributedOf([called(1, { value: 'zorpLauncher' })], item('use zorpLauncher'))).toBe(true);
  });

  it('credits a path, however short its segments', () => {
    expect(contributedOf([called(1, { file_path: 'qa/b.ts' })], item('see qa/b.ts'))).toBe(true);
  });

  it('credits the id of the item', () => {
    expect(contributedOf([said(1, 'per note-q7')], item('ab cd', { id: 'note-q7' }))).toBe(true);
  });

  it('counts six characters as an identifier and five as not', () => {
    expect(contributedOf([said(1, 'abcdef')], item('abcdef'))).toBe(true);
    expect(contributedOf([said(1, 'abcde')], item('abcde'))).toBe(false);
  });

  it('matches whole identifiers, not substrings', () => {
    expect(contributedOf([said(1, 'zorpLauncherTwo')], item('use zorpLauncher'))).toBe(false);
  });

  it('never credits an item when no step names it', () => {
    expect(contributedOf([said(1, 'nothing relevant')], item('use zorpLauncher'))).toBe(false);
  });

  it('gives nothing for an identifier present in the task', () => {
    expect(contributedOf([said(1, 'zorpLauncher')], item('use zorpLauncher'), 'Fix zorpLauncher')).toBe(false);
  });

  it('gives nothing for an identifier in an earlier tool output', () => {
    expect(contributedOf([toolOutput('saw zorpLauncher'), said(2, 'zorpLauncher')], item('use zorpLauncher'))).toBe(false);
  });

  it('gives nothing for an identifier in an earlier user message', () => {
    expect(contributedOf([{ type: 'user.message', text: 'try zorpLauncher' }, said(2, 'zorpLauncher')], item('use zorpLauncher'))).toBe(false);
  });

  it('gives nothing for an identifier in history inherited from an earlier run', () => {
    const inherited: RunEventPayload = {
      type: 'context.inherited',
      fromRunId: 'r0',
      fromLastSeq: 1,
      history: [{ seq: 1, item: { type: 'message', role: 'user', content: 'zorpLauncher' } }],
      nextItemSeq: 2,
      evicted: [],
      closures: [],
      markers: [],
      digest: 'd',
    };
    expect(contributedOf([inherited, said(1, 'zorpLauncher')], item('use zorpLauncher'))).toBe(false);
  });

  it('keeps a credit earned first, even when a later step repeats the identifier', () => {
    expect(contributedOf([said(1, 'zorpLauncher'), said(2, 'zorpLauncher')], item('use zorpLauncher'))).toBe(true);
  });

  it('credits every item that names the same new identifier', () => {
    const results = measureContribution({
      events: journal([said(1, 'zorpLauncher')]),
      task: TASK,
      injected: [item('use zorpLauncher', { id: 'q1' }), item('zorpLauncher again', { id: 'q2' })],
    });
    expect(results.map((result) => result.contributed)).toEqual([true, true]);
  });

  it('credits an item for an identifier replaced by compaction, because it is no longer retained', () => {
    const payloads = [toolOutput('saw zorpLauncher'), compaction(1), said(2, 'zorpLauncher')];
    expect(contributedOf(payloads, item('use zorpLauncher', { kind: 'summary', id: 'summary-2', fromSeq: 2 }))).toBe(true);
  });

  it('does not credit an item for a step before it was injected', () => {
    expect(contributedOf([said(1, 'zorpLauncher'), compaction(1)], item('use zorpLauncher', { kind: 'summary', id: 'summary-2', fromSeq: 2 }))).toBe(false);
  });

  it.each<ContributionKind>(['memory', 'governing', 'summary', 'working_state'])('measures %s and reports it by kind and id', (kind) => {
    expect(measureContribution({ events: journal([said(1, 'zorpLauncher')]), task: TASK, injected: [item('use zorpLauncher', { kind, id: 'x1' })] })).toEqual([{ kind, id: 'x1', contributed: true }]);
  });

  it('reports nothing when nothing was injected', () => {
    expect(measureContribution({ events: journal([said(1, 'zorpLauncher')]), task: TASK, injected: [] })).toEqual([]);
  });

  it('never changes the result when an item is added whose identifiers all appear earlier', () => {
    let state = 20_260_411;
    const below = (limit: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.floor((state / 0x100000000) * limit);
    };
    const pool = Array.from({ length: 12 }, (_unused, index) => `tokenz${index}x`);
    const pick = (): string => pool[below(pool.length)] as string;
    for (let round = 0; round < 200; round += 1) {
      const known = [pick(), pick(), pick()];
      const task = `Work on ${known.join(' ')}`;
      const payloads = Array.from({ length: 1 + below(5) }, (_unused, index) => said(index + 1, `${pick()} ${pick()}`));
      const events = journal(payloads);
      const injected = [item(`note ${pick()}`, { id: 'q1' }), item(`note ${pick()} ${pick()}`, { id: 'q2', kind: 'governing' })];
      const decoy = item(known.join(' '), { id: 'q3', kind: 'working_state' });
      const without = measureContribution({ events, task, injected });
      const withDecoy = measureContribution({ events, task, injected: [...injected, decoy] });
      expect(withDecoy.slice(0, 2)).toEqual(without);
      expect(withDecoy[2]).toEqual({ kind: 'working_state', id: 'q3', contributed: false });
    }
  });
});

const runs = (count: number, injected: number, used: number, memoriesDropped = false): ContributionWindowRun[] =>
  Array.from({ length: count }, () => ({ injected, used, memoriesDropped }));

describe('nextMemoryShare', () => {
  it('halves below a quarter used', () => {
    expect(nextMemoryShare({ previous: 1 / 4, runs: [...runs(1, 4, 0), ...runs(19, 4, 1)] })).toBe(1 / 8);
  });

  it('holds at exactly a quarter used', () => {
    expect(nextMemoryShare({ previous: 1 / 4, runs: runs(20, 4, 1) })).toBe(1 / 4);
  });

  it('doubles above three quarters used while memories_dropped fired in one run', () => {
    expect(nextMemoryShare({ previous: 1 / 4, runs: [...runs(1, 4, 4, true), ...runs(19, 4, 3)] })).toBe(1 / 2);
  });

  it('holds at exactly three quarters used even when memories were dropped', () => {
    expect(nextMemoryShare({ previous: 1 / 4, runs: runs(20, 4, 3, true) })).toBe(1 / 4);
  });

  it('holds above three quarters used when no memory was dropped', () => {
    expect(nextMemoryShare({ previous: 1 / 4, runs: runs(20, 4, 4) })).toBe(1 / 4);
  });

  it('compounds on the previous share', () => {
    expect(nextMemoryShare({ previous: 1 / 8, runs: runs(20, 1, 0) })).toBe(1 / 16);
  });

  it('clamps at the floor of one sixteenth', () => {
    expect(nextMemoryShare({ previous: 1 / 16, runs: runs(20, 1, 0) })).toBe(1 / 16);
  });

  it('clamps at the ceiling of one half', () => {
    expect(nextMemoryShare({ previous: 1 / 2, runs: runs(20, 1, 1, true) })).toBe(1 / 2);
  });

  it('holds the share with fewer than twenty runs, because the window the rule is defined over is not yet full', () => {
    expect(nextMemoryShare({ previous: 1 / 8, runs: runs(19, 1, 0) })).toBe(1 / 8);
    expect(nextMemoryShare({ previous: 1 / 8, runs: runs(19, 1, 1, true) })).toBe(1 / 8);
  });

  it('starts from a quarter when no share was recorded', () => {
    expect(nextMemoryShare({ previous: undefined, runs: [] })).toBe(1 / 4);
    expect(nextMemoryShare({ previous: undefined, runs: runs(20, 1, 0) })).toBe(1 / 8);
  });

  it('holds when the window injected no memory, because the ratio is undefined', () => {
    expect(nextMemoryShare({ previous: 1 / 4, runs: runs(20, 0, 0, true) })).toBe(1 / 4);
  });
});
