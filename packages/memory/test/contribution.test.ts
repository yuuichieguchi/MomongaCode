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

const compaction = (replacedThroughSeq: number, summary = 's'): RunEventPayload => ({ type: 'context.compacted', item: { type: 'message', role: 'user', content: summary }, summary, replacedThroughSeq });

const layer = (role: 'system' | 'developer' | 'user', content: string): unknown => ({ type: 'message', role, content });

const requested = (step: number, input: readonly unknown[], tools: readonly unknown[] = []): RunEventPayload =>
  ({ type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { model: 'fm', input, tools } }) as RunEventPayload;

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

describe('what the model was shown before the step', () => {
  const SYSTEM = layer('system', 'Be careful. You should run the checks before you answer, and return the result.');

  it('earns nothing for plain words that the system prompt already showed', () => {
    const payloads = [requested(1, [SYSTEM, layer('user', 'Fix it')]), said(1, 'I will run the checks before I answer, as I should')];
    expect(contributedOf(payloads, item('Always run tests before pushing, you should'))).toBe(false);
  });

  it('still earns credit for a word that only the memory carried', () => {
    const payloads = [requested(1, [SYSTEM]), said(1, 'zorpLauncher is the thing to run before I answer')];
    expect(contributedOf(payloads, item('use zorpLauncher before pushing'))).toBe(true);
  });

  it('earns nothing for words of a tool definition', () => {
    const tools = [{ type: 'function', name: 'Read', description: 'Reads a file from the filesystem', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'absolute pathname' } } } }];
    expect(contributedOf([requested(1, [SYSTEM], tools), said(1, 'filesystem pathname')], item('filesystem pathname'))).toBe(false);
  });

  it('counts an instruction file loaded as a developer layer', () => {
    const payloads = [requested(1, [SYSTEM, layer('developer', 'Instruction file: prefer hermetic builds')]), said(1, 'a hermetic build')];
    expect(contributedOf(payloads, item('hermetic mode, please'))).toBe(false);
  });

  it('counts a layer of a later request only from that request on', () => {
    const payloads = [requested(1, [SYSTEM]), said(1, 'hermetic'), requested(2, [SYSTEM, layer('developer', 'prefer hermetic builds')])];
    expect(contributedOf(payloads, item('hermetic mode, please'))).toBe(true);
  });

  it('leaves the text of the injected memory out of what was shown, and keeps the framing around it', () => {
    const memory = item('use zorpLauncher before pushing');
    const rendered = layer('developer', 'Verify a note before relying on it.\n<recalled_memories>\n<memory id="q1">use zorpLauncher before pushing</memory>\n</recalled_memories>');
    expect(contributedOf([requested(1, [SYSTEM, rendered]), said(1, 'zorpLauncher')], memory)).toBe(true);
    expect(contributedOf([requested(1, [rendered]), said(1, 'before')], item('use zorpLauncher before pushing'))).toBe(false);
  });

  it('leaves the escaped text of the injected memory out as well', () => {
    const memory = item('keep <zorpLauncher> & friends');
    const rendered = layer('developer', '<memory id="q1">keep &lt;zorpLauncher&gt; &amp; friends</memory>');
    expect(contributedOf([requested(1, [rendered]), said(1, 'zorpLauncher')], memory)).toBe(true);
  });

  it('leaves the text of an injected governing fact out of what was shown', () => {
    const rendered = layer('developer', 'Governing facts.\n\n[g1] rule about build: run zorpLauncher');
    expect(contributedOf([requested(1, [rendered]), said(1, 'zorpLauncher')], item('run zorpLauncher', { kind: 'governing', id: 'g1' }))).toBe(true);
  });

  it('earns nothing for plain Japanese words that the system prompt already showed', () => {
    const system = layer('system', 'ユーザーの依頼を必ず確認してください。');
    expect(contributedOf([requested(1, [system]), said(1, '確認してから進めます')], item('設定ファイルを確認すること'))).toBe(false);
  });

  it('still earns credit for a Japanese word that only the memory carried', () => {
    const system = layer('system', 'ユーザーの依頼を必ず確認してください。');
    expect(contributedOf([requested(1, [system]), said(1, '設定を変更します')], item('設定ファイルを確認すること'))).toBe(true);
  });

  it('cuts only the block of the injected memory and leaves the same words elsewhere in the layer', () => {
    const rendered = layer(
      'developer',
      'Prefer hermetic builds.\n<recalled_memories>\n<memory id="q1" scope="user" status="unbound">hermetic</memory>\n<memory id="q2" scope="user" status="unbound">other note</memory>\n</recalled_memories>',
    );
    expect(contributedOf([requested(1, [rendered]), said(1, 'hermetic')], item('hermetic', { id: 'q1' }))).toBe(false);
    const onlyInTheBlock = layer('developer', '<recalled_memories>\n<memory id="q1" scope="user" status="unbound">hermetic</memory>\n</recalled_memories>');
    expect(contributedOf([requested(1, [onlyInTheBlock]), said(1, 'hermetic')], item('hermetic', { id: 'q1' }))).toBe(true);
  });

  it('cuts only the line of the injected governing fact and leaves the same words elsewhere in the layer', () => {
    const rendered = layer('developer', 'Governing facts. Keep builds hermetic.\n\n[g1] rule about build: hermetic\n[g2] rule about test: other fact');
    expect(contributedOf([requested(1, [rendered]), said(1, 'hermetic')], item('hermetic', { kind: 'governing', id: 'g1' }))).toBe(false);
    const onlyInTheLine = layer('developer', 'Governing facts.\n\n[g1] rule about build: hermetic');
    expect(contributedOf([requested(1, [onlyInTheLine]), said(1, 'hermetic')], item('hermetic', { kind: 'governing', id: 'g1' }))).toBe(true);
  });

  it('cuts a governing fact that spans several lines', () => {
    const text = 'use zorpLauncher\nand then stop';
    const rendered = layer('developer', `Governing facts.\n\n[g1] rule about build: ${text}\n[g2] rule about test: other fact`);
    expect(contributedOf([requested(1, [rendered]), said(1, 'zorpLauncher')], item(text, { kind: 'governing', id: 'g1' }))).toBe(true);
  });

  it('rejects a recorded request that has no input list', () => {
    const malformed = { type: 'model.requested', step: 1, attempt: 1, digest: 'd', body: { model: 'fm' } } as RunEventPayload;
    expect(() => contributedOf([malformed, said(1, 'zorpLauncher')], item('use zorpLauncher'))).toThrow(/model\.requested/);
  });
});

describe('the summary and the working state on screen after a compaction', () => {
  const summaryKeeping = compaction(1, 'The run touched parseLockfile in the loader');

  it('counts the summary text as on screen for an item injected after the compaction', () => {
    const governing = item('parse with parseLockfile', { kind: 'governing', id: 'g1', fromSeq: 2 });
    expect(contributedOf([toolOutput('x'), summaryKeeping, said(3, 'parseLockfile')], governing)).toBe(false);
    expect(contributedOf([toolOutput('x'), compaction(1, 'nothing here'), said(3, 'parseLockfile')], governing)).toBe(true);
  });

  it('lets the summary earn credit for its own text', () => {
    const summary = item('The run touched parseLockfile in the loader', { kind: 'summary', id: 'summary-2', fromSeq: 2 });
    expect(contributedOf([toolOutput('x'), summaryKeeping, said(3, 'parseLockfile')], summary)).toBe(true);
  });

  it('counts the working state rendered at the compaction as on screen for the other items', () => {
    const events = journal([toolOutput('x'), compaction(1), said(3, 'src/app/lockfile.ts')]);
    const workingStates = [{ seq: 2, text: 'src/app/lockfile.ts' }];
    const memory = item('see src/app/lockfile.ts', { fromSeq: 2 });
    const workingState = item('src/app/lockfile.ts', { kind: 'working_state', id: 'working-state', fromSeq: 2 });
    expect(measureContribution({ events, task: TASK, injected: [memory, workingState], workingStates })).toEqual([
      { kind: 'memory', id: 'q1', contributed: false },
      { kind: 'working_state', id: 'working-state', contributed: true },
    ]);
  });

  it('replaces the working state of an earlier compaction with the one of the next', () => {
    const events = journal([compaction(0), compaction(0), said(3, 'src/app/lockfile.ts')]);
    const workingStates = [
      { seq: 1, text: 'src/app/lockfile.ts' },
      { seq: 2, text: 'src/app/other.ts' },
    ];
    expect(measureContribution({ events, task: TASK, injected: [item('see src/app/lockfile.ts', { fromSeq: 2 })], workingStates })[0]?.contributed).toBe(true);
  });
});

describe('items with their own window', () => {
  it('credits a step inside the window and not a step after it', () => {
    const window = (untilSeq: number): InjectedItem => item('src/app/lockfile.ts', { kind: 'working_state', id: 'working-state', fromSeq: 1, untilSeq });
    expect(contributedOf([said(1, 'src/app/lockfile.ts')], window(3))).toBe(true);
    expect(contributedOf([toolOutput('x'), toolOutput('y'), toolOutput('z'), said(2, 'src/app/lockfile.ts')], window(3))).toBe(false);
  });

  it('reports items that share a kind and an id once, credited when any of them is', () => {
    const early = item('src/early.ts', { kind: 'working_state', id: 'working-state', fromSeq: 1, untilSeq: 2 });
    const late = item('src/late.ts', { kind: 'working_state', id: 'working-state', fromSeq: 2 });
    expect(measureContribution({ events: journal([toolOutput('x'), said(2, 'src/late.ts')]), task: TASK, injected: [early, late] })).toEqual([
      { kind: 'working_state', id: 'working-state', contributed: true },
    ]);
    expect(measureContribution({ events: journal([toolOutput('x'), said(2, 'nothing')]), task: TASK, injected: [early, late] })).toEqual([
      { kind: 'working_state', id: 'working-state', contributed: false },
    ]);
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
