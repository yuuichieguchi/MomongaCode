import { describe, expect, it } from 'vitest';
import { renderWorkingState, workingStateCapFor } from '@momonga/context';
import { sha256Hex } from '@momonga/foundation';
import { tokensForText } from '@momonga/protocol';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { capabilitiesFor, makeEnv } from './harness.ts';

const IDS = { runId: 'run-ws', sessionId: 'session-ws' };
const USAGE = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const LARGE_CAP = 4096;
const READERS = { history_range: 'HistoryRead' } as const;

const tokensOf = (text: string): number => Math.ceil(text.length / 4);

const journal = (payloads: readonly RunEventPayload[]): RunEvent[] =>
  payloads.map((payload, index) => ({ ...payload, id: index + 1, ...IDS, seq: index + 1, step: 1, leaseToken: 1, createdAt: 1 }) as RunEvent);

const fold = (payloads: readonly RunEventPayload[]): RunState => journal(payloads).reduce(foldRunState, initialRunState(IDS));

const toolCall = (callId: string, name: string, rawInput: unknown): RunEventPayload[] => [
  {
    type: 'model.responded',
    step: 1,
    attempt: 1,
    response: { status: 'completed', output: [{ type: 'function_call', call_id: callId, name, arguments: JSON.stringify(rawInput) }], usage: USAGE },
  },
  { type: 'tool.call', callId, providerCallId: callId, name, kind: 'other', title: name, rawInput },
];

type Completed = Extract<RunEventPayload, { type: 'tool.completed' }>;

const tool = (callId: string, name: string, rawInput: unknown, status: 'completed' | 'failed', output: string, extra: Partial<Completed> = {}): RunEventPayload[] => [
  ...toolCall(callId, name, rawInput),
  { type: 'tool.completed', callId, status, output, ...extra },
];

const written = (path: string, content: string): Partial<Completed> => ({ files: [{ path, sha256: sha256Hex(content), access: 'write' }] });

const write = (id: string, path: string, content: string): RunEventPayload[] =>
  tool(id, 'Write', { file_path: path, content }, 'completed', `Created ${path}`, written(path, content));
const edit = (id: string, path: string, updated: string): RunEventPayload[] =>
  tool(id, 'Edit', { file_path: path, old_string: 'a', new_string: 'b' }, 'completed', `Updated ${path}`, written(path, updated));
const bash = (id: string, command: string, code: number): RunEventPayload[] =>
  tool(id, 'Bash', { command }, code === 0 ? 'completed' : 'failed', code === 0 ? 'ok' : 'boom', { command, exitCode: code, files: [] });

const TASK: RunEventPayload = { type: 'user.message', text: 'the original task' };

const compactedThrough = (replacedThroughSeq: number): RunEventPayload => ({
  type: 'context.compacted',
  item: { type: 'message', role: 'user', content: 'summary' },
  summary: 'summary',
  replacedThroughSeq,
  source: 'model',
});

const render = (state: RunState, options: { cap?: number; verificationCommands?: readonly string[] } = {}): string => {
  const text = renderWorkingState(state, { capTokens: options.cap ?? LARGE_CAP, tokensOf, verificationCommands: options.verificationCommands ?? ['npm test'], readers: READERS });
  if (text === undefined) throw new Error('no working state rendered');
  return text;
};

describe('entries', () => {
  it('renders nothing before a summary exists', async () => {
    expect(renderWorkingState(fold([TASK]), { capTokens: LARGE_CAP, tokensOf, verificationCommands: [], readers: READERS })).toBeUndefined();
  });

  it('lists a written file with the hash of the content recorded in the Write input', async () => {
    const text = render(fold([TASK, ...write('w', '/p/a.ts', 'hello'), compactedThrough(1)]));
    expect(text).toContain('/p/a.ts');
    expect(text).toContain(sha256Hex('hello'));
  });

  it('keeps only the last hash of a file written twice', async () => {
    const text = render(fold([TASK, ...write('w1', '/p/a.ts', 'one'), ...write('w2', '/p/a.ts', 'two'), compactedThrough(1)]));
    expect(text).not.toContain(sha256Hex('one'));
    expect(text).toContain(sha256Hex('two'));
    expect(text.split('/p/a.ts')).toHaveLength(2);
  });

  it('lists an edited file with the hash recorded at the tool boundary', async () => {
    const text = render(fold([TASK, ...edit('e', '/p/b.ts', 'edited content'), compactedThrough(1)]));
    expect(text).toContain('/p/b.ts');
    expect(text).toContain(sha256Hex('edited content'));
  });

  it('omits a write that failed', async () => {
    const text = render(fold([TASK, ...tool('w', 'Write', { file_path: '/p/no.ts', content: 'x' }, 'failed', 'denied'), compactedThrough(1)]));
    expect(text).not.toContain('/p/no.ts');
  });

  it('states the hash as unknown for a written file the observer could not hash', async () => {
    const text = render(fold([TASK, ...tool('w', 'Sh', { script: 'gen' }, 'completed', 'ran', { command: 'gen', exitCode: 0, files: [{ path: '/p/old.ts', access: 'write' }] }), compactedThrough(1)]));
    expect(text).toContain('/p/old.ts, sha256 unknown');
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it('lists no file for a write whose event carries no files, whatever the arguments say', async () => {
    const text = render(fold([TASK, ...tool('w', 'Write', { file_path: '/p/old.ts', content: 'x' }, 'completed', 'Created /p/old.ts'), compactedThrough(1)]));
    expect(text).not.toContain('/p/old.ts');
  });

  it('states the exit code as unknown for a command recorded without one', async () => {
    const text = render(fold([TASK, ...tool('b', 'Bash', { command: 'make lint' }, 'failed', 'boom\n[exit code 2]', { command: 'make lint', files: [] }), compactedThrough(1)]));
    expect(text).toMatch(/failed[^\n]*`make lint`[^\n]*exit code unknown/);
    expect(text).not.toMatch(/exit code 2/);
  });

  it('takes no command from a call that was denied or rejected', async () => {
    const denied = tool('d', 'Bash', { command: 'rm -rf /' }, 'failed', 'Permission denied: rule', { command: 'rm -rf /', files: [], denial: { source: 'rule', reason: 'rule' } });
    const rejected: RunEventPayload[] = [
      ...toolCall('r', 'Bash', { command: 'make deploy' }),
      {
        type: 'tool.permission.requested',
        approvalId: 'approval-r',
        callId: 'r',
        options: [{ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }],
        subjectDigest: 'digest',
        reason: 'shell commands require approval',
      },
      { type: 'tool.permission.resolved', approvalId: 'approval-r', optionId: 'reject_once' },
      { type: 'tool.completed', callId: 'r', status: 'failed', output: 'The user rejected this tool call.', command: 'make deploy', files: [] },
    ];
    const text = render(fold([TASK, ...denied, ...rejected, compactedThrough(1)]));
    expect(text).not.toContain('rm -rf');
    expect(text).not.toContain('make deploy');
  });

  it('takes a background launch for neither a success nor a failure', async () => {
    const launched = tool('b', 'Bash', { command: 'make lint', run_in_background: true }, 'completed', 'Started background job job_1');
    expect(render(fold([TASK, ...bash('a', 'make lint', 2), ...launched, compactedThrough(1)]))).toMatch(/failed[^\n]*`make lint`/);
  });

  it('gives the last verification command with its exit code', async () => {
    const text = render(fold([TASK, ...bash('a', 'npm test', 0), ...bash('b', 'npm test', 3), ...bash('c', 'ls', 0), compactedThrough(1)]));
    expect(text).toMatch(/verification[^\n]*`npm test`[^\n]*exit code 3/i);
  });

  it('does not take a command outside the verification list for verification', async () => {
    expect(render(fold([TASK, ...bash('a', 'ls', 0), compactedThrough(1)]))).not.toMatch(/verification/i);
  });

  it('lists a failed command not yet followed by a success', async () => {
    expect(render(fold([TASK, ...bash('a', 'make lint', 2), compactedThrough(1)]))).toMatch(/failed[^\n]*`make lint`/i);
  });

  it('drops a failed command once the same command succeeds', async () => {
    expect(render(fold([TASK, ...bash('a', 'make lint', 2), ...bash('b', 'make lint', 0), compactedThrough(1)]))).not.toContain('make lint');
  });

  it('keeps a failed command when a different one succeeds', async () => {
    expect(render(fold([TASK, ...bash('a', 'make lint', 2), ...bash('b', 'make docs', 0), compactedThrough(1)]))).toContain('make lint');
  });

  it('lists unfinished entries of the latest plan only', async () => {
    const entry = (content: string, status: 'pending' | 'in_progress' | 'completed') => ({ content, priority: 'high' as const, status });
    const text = render(
      fold([
        TASK,
        { type: 'plan.updated', entries: [entry('stale step', 'pending')] },
        { type: 'plan.updated', entries: [entry('open step', 'pending'), entry('active step', 'in_progress'), entry('closed step', 'completed')] },
        compactedThrough(1),
      ]),
    );
    expect(text).toContain('open step');
    expect(text).toContain('active step');
    expect(text).not.toContain('closed step');
    expect(text).not.toContain('stale step');
  });

  it('quotes user messages since the task verbatim, without the task', async () => {
    const text = render(fold([TASK, { type: 'user.message', text: 'Use  two  spaces\nand keep this line.' }, compactedThrough(1)]));
    expect(text).toContain('Use  two  spaces\nand keep this line.');
    expect(text).not.toContain('the original task');
  });

  it('names the replaced journal range and HistoryRead', async () => {
    const payloads = [TASK, ...write('w', '/p/a.ts', 'x'), ...write('w2', '/p/b.ts', 'y'), compactedThrough(3)];
    const text = render(fold(payloads));
    expect(text).toContain('HistoryRead');
    expect(text).toMatch(/seqFrom[ :=]+1\b[\s\S]*seqTo[ :=]+4\b/);
  });
});

describe('surviving compaction', () => {
  it('keeps entries whose history was replaced, across a second compaction', async () => {
    const state = fold([TASK, ...write('w', '/p/a.ts', 'x'), ...bash('b', 'make lint', 2), compactedThrough(3), compactedThrough(5)]);
    expect(state.history.some((entry) => entry.item.type === 'function_call')).toBe(false);
    const text = render(state);
    expect(text).toContain('/p/a.ts');
    expect(text).toContain('make lint');
  });
});

describe('the cap', () => {
  const messages = Array.from({ length: 40 }, (_, index): RunEventPayload => ({ type: 'user.message', text: `message-${String(index).padStart(2, '0')} ${'x'.repeat(60)}` }));
  const state = fold([TASK, ...messages, compactedThrough(1)]);
  const CAP = 128;

  it('stays within the cap', async () => {
    expect(tokensOf(render(state, { cap: CAP }))).toBeLessThanOrEqual(CAP);
  });

  it('drops the oldest entries and keeps the newest', async () => {
    const text = render(state, { cap: CAP });
    expect(text).toContain('message-39');
    expect(text).not.toContain('message-00');
  });

  it('marks what it dropped with the seq range of those entries', async () => {
    const text = render(state, { cap: CAP });
    const marker = /omitted[^\n]*seq (\d+)-(\d+)/.exec(text);
    expect(marker?.[1]).toBe('2');
    const firstKept = Number(/message-(\d\d)/.exec(text)?.[1]);
    expect(Number(marker?.[2])).toBe(firstKept + 1);
  });

  it('keeps the HistoryRead line whatever it drops', async () => {
    expect(render(state, { cap: CAP })).toContain('HistoryRead');
  });

  it('has no marker when everything fits', async () => {
    expect(render(state)).not.toMatch(/omitted/);
  });
});

describe('reconciled calls', () => {
  const reconciled = (id: string, name: string, rawInput: unknown, outcome: 'already_applied' | 'not_applied' | 'unknown', facts: Record<string, unknown> = {}): RunEventPayload[] => [
    ...toolCall(id, name, rawInput),
    { type: 'tool.reconciled', callId: id, outcome, output: 'recovered', ...facts } as RunEventPayload,
  ];

  const pathFacts = (path: string): Record<string, unknown> => ({ files: [{ path, access: 'write' }] });

  it('lists a write the recovery found already applied, with the outcome and an unknown hash', async () => {
    const text = render(fold([TASK, ...reconciled('w', 'Write', { file_path: '/p/a.ts', content: 'x' }, 'already_applied', pathFacts('/p/a.ts')), compactedThrough(1)]));
    expect(text).toMatch(/reconciled: already_applied[^\n]*\/p\/a\.ts[^\n]*sha256 unknown/);
  });

  it('lists a write whose effect is unknown with that outcome', async () => {
    const text = render(fold([TASK, ...reconciled('w', 'Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }, 'unknown', pathFacts('/p/a.ts')), compactedThrough(1)]));
    expect(text).toMatch(/reconciled: unknown[^\n]*\/p\/a\.ts/);
  });

  it('lists nothing for a write that was not applied', async () => {
    const text = render(fold([TASK, ...reconciled('w', 'Write', { file_path: '/p/a.ts', content: 'x' }, 'not_applied', pathFacts('/p/a.ts')), compactedThrough(1)]));
    expect(text).not.toContain('/p/a.ts');
  });

  it('lists a reconciled command with its outcome, neither as a success nor as a failure', async () => {
    const text = render(fold([TASK, ...reconciled('b', 'Bash', { command: 'make lint' }, 'unknown', { command: 'make lint' }), compactedThrough(1)]));
    expect(text).toMatch(/reconciled: unknown[^\n]*`make lint`/);
    expect(text).not.toMatch(/command failed/);
  });
});

describe('an oversized entry', () => {
  it('is cut with a marker naming its seq, and the other entries stay', async () => {
    const payloads = [TASK, ...write('w', '/p/a.ts', 'x'), ...bash('b', 'make lint', 2), { type: 'user.message', text: 'm'.repeat(600) } as RunEventPayload, compactedThrough(1)];
    const text = render(fold(payloads), { cap: 123 });
    expect(text).toContain('/p/a.ts');
    expect(text).toContain('`make lint`');
    expect(text).toMatch(/user message:\nm+[^\n]*\[cut: seq \d+\]/);
    expect(text).not.toContain('m'.repeat(600));
    expect(tokensOf(text)).toBeLessThanOrEqual(123);
  });

  it('keeps the pending plan and the last verification whatever newer messages arrive', async () => {
    const entry = { content: 'open step', priority: 'high' as const, status: 'pending' as const };
    const messages = Array.from({ length: 40 }, (_unused, index): RunEventPayload => ({ type: 'user.message', text: `message-${String(index).padStart(2, '0')} ${'x'.repeat(60)}` }));
    const text = render(fold([TASK, ...bash('v', 'npm test', 1), { type: 'plan.updated', entries: [entry] }, ...messages, compactedThrough(1)]), { cap: 128 });
    expect(text).toContain('open step');
    expect(text).toMatch(/last verification: `npm test`/);
    expect(text).toContain('message-39');
    expect(text).not.toContain('message-00');
    expect(tokensOf(text)).toBeLessThanOrEqual(128);
  });
});

describe('inherited history', () => {
  const inheritedFrom = (workingFacts: Partial<RunState['workingFacts']>): RunState => ({
    ...fold([TASK, compactedThrough(1)]),
    taskSeq: 3,
    inherited: { fromRunId: 'run-parent', fromLastSeq: 12, digest: 'digest' },
    workingFacts: { written: [], commands: [], messages: [], itemEvents: [], ...workingFacts },
  });

  it('names the journal of the parent run when inherited items were replaced', async () => {
    const text = render(inheritedFrom({ written: [{ path: '/p/parent.ts', sha256: sha256Hex('p'), seq: 0 }] }));
    expect(text).toContain('/p/parent.ts');
    expect(text).toMatch(/HistoryRead runId: run-parent, seqFrom: 1, seqTo: 12/);
    expect(text).not.toMatch(/HistoryRead seqFrom/);
  });

  it('counts dropped inherited entries by their run instead of by a seq range', async () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({ text: `parent-${String(index).padStart(2, '0')} ${'x'.repeat(60)}`, seq: 0 }));
    const text = render(inheritedFrom({ messages }), { cap: 128 });
    expect(text).toMatch(/omitted \d+ older entries: \d+ inherited$/m);
    expect(text).not.toMatch(/omitted[^\n]*seq \d/);
    expect(text).toContain('parent-39');
  });
});

describe('the smallest cap', () => {
  it('holds the widest mandatory lines of a child run that compacted its own history, at the smallest window', async () => {
    const widest = 9_999_999;
    const state: RunState = {
      ...fold([TASK, compactedThrough(1)]),
      taskSeq: 3,
      inherited: { fromRunId: '01a3185c-5000-745f-8ed8-f61784e21274', fromLastSeq: widest, digest: 'digest' },
      workingFacts: {
        written: [],
        commands: [],
        messages: [
          { text: 'x'.repeat(200), seq: 0 },
          { text: 'y'.repeat(200), seq: widest },
        ],
        itemEvents: [],
        replacedThroughEventSeq: widest,
      },
    };
    const capTokens = workingStateCapFor(capabilitiesFor(1024));

    const text = renderWorkingState(state, { capTokens, tokensOf: tokensForText, verificationCommands: [], readers: READERS });

    expect(text).toContain('inherited replaced: HistoryRead runId: 01a3185c-5000-745f-8ed8-f61784e21274');
    expect(text).toContain('omitted 1 older entry: 1 inherited');
    expect(text).toContain(`[cut: seq ${widest}]`);
    expect(tokensForText(text ?? '')).toBeLessThanOrEqual(capTokens);
  });
});

describe('mandatory lines wider than the cap', () => {
  it('keep their own width as the floor and drop every entry, instead of failing the run', async () => {
    const widest = Number.MAX_SAFE_INTEGER;
    const state: RunState = {
      ...fold([TASK, compactedThrough(1)]),
      taskSeq: 3,
      inherited: { fromRunId: '01a3185c-5000-745f-8ed8-f61784e21274', fromLastSeq: widest, digest: 'digest' },
      workingFacts: {
        written: [],
        commands: [],
        messages: [{ text: 'kept only if it fits', seq: widest }],
        itemEvents: [],
        replacedThroughEventSeq: widest,
      },
    };
    const capTokens = 20;

    const text = renderWorkingState(state, { capTokens, tokensOf: tokensForText, verificationCommands: [], readers: READERS }) ?? '';

    expect(text).toContain(`seqTo: ${widest}`);
    expect(text).toContain('omitted 1 older entry');
    expect(text).not.toContain('kept only if it fits');
    expect(tokensForText(text)).toBeGreaterThan(capTokens);
  });
});

describe('recovery', () => {
  const snapshotted = async (payloads: readonly RunEventPayload[]) => {
    const env = await makeEnv();
    const run = env.enqueue('the original task');
    const claim = await env.seed(run.id, payloads, 'hold');
    const state = env.fold(run.id);
    expect(env.store.writeSnapshot(claim, state.lastSeq, state)).toEqual({ kind: 'ok' });
    return { env, run, claim, state };
  };

  it('renders the same text from a snapshot as from the journal', async () => {
    const { env, run, state } = await snapshotted([...write('w', '/p/a.ts', 'x'), ...bash('b', 'npm test', 1), compactedThrough(1)]);
    const restored = env.store.load(run.id).snapshot?.state as RunState;
    expect(restored).toEqual(state);
    expect(render(restored)).toBe(render(state));
  });

  it('renders the same text from a snapshot followed by more events', async () => {
    const { env, run, claim } = await snapshotted([...write('w', '/p/a.ts', 'x'), compactedThrough(1)]);
    expect(env.store.append(claim, bash('b', 'make lint', 2)).kind).toBe('ok');
    const loaded = env.store.load(run.id);
    const recovered = loaded.tail.reduce(foldRunState, loaded.snapshot?.state as RunState);
    expect(loaded.tail.length).toBeGreaterThan(0);
    expect(render(recovered)).toBe(render(env.fold(run.id)));
  });
});
