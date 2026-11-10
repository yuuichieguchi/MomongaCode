import { describe, expect, it } from 'vitest';
import { UNKNOWN_EFFECT_ADVICE, UNKNOWN_EFFECT_REASON, unknownEffectOptions } from '@momonga/protocol';
import type { PublicRunEvent } from '@momonga/protocol';
import { createMapperState, mapChildEvent, mapRunEvent } from '../src/acp/events.ts';
import type { ClientFeatures } from '../src/acp/events.ts';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import { pendingLines } from '../src/commands/runs.ts';
import { asChildEvent } from '../src/run/child-events.ts';
import { createFrameSink } from '../src/run/headless.ts';
import { approvalSpec, approvalWording } from '../src/tui/screen/prompt-panel.tsx';
import { frameOf } from './acp-harness.ts';
import type { EventPayload } from './acp-harness.ts';
import { fold } from './tui/screen-fakes.ts';

const FOUND = 'An earlier attempt of Write was interrupted before it reported a result.';
const OPTIONS = unknownEffectOptions();

const callOf = (callId: string, title: string) => ({ type: 'tool.call', callId, providerCallId: callId, name: 'Write', kind: 'edit', title, rawInput: { file_path: '/a.txt' } }) as const;
const reconciledOf = (callId: string) => ({ type: 'tool.reconciled', callId, outcome: 'unknown', output: FOUND }) as const;
const asked = (callIds: string[]) => ({ type: 'tool.unknown.requested', approvalId: 'ap1', callIds, options: OPTIONS, subjectDigest: 'd' }) as const;

const TEXT_ONE = [`Write /a.txt: ${UNKNOWN_EFFECT_REASON}`, `What the recovery found: ${FOUND}`, UNKNOWN_EFFECT_ADVICE];
const TEXT_TWO = [`Write /a.txt: ${UNKNOWN_EFFECT_REASON}`, `What the recovery found: ${FOUND}`, `Write /b.txt: ${UNKNOWN_EFFECT_REASON}`, `What the recovery found: ${FOUND}`, UNKNOWN_EFFECT_ADVICE];

describe('the texts of an unknown effect', () => {
  it('say why the effect is unknown and what to do', () => {
    expect(UNKNOWN_EFFECT_REASON).toBe('Its effect is unknown because the runtime stopped while it ran.');
    expect(UNKNOWN_EFFECT_ADVICE).toBe('Inspect the current state, then continue. To stop instead, cancel the run.');
    expect(OPTIONS).toEqual([{ optionId: 'allow_once', name: 'Continue', kind: 'allow_once' }]);
  });
});

describe('headless', () => {
  let sequence = 0;
  const frame = (event: Record<string, unknown>): RunEventFrame => {
    sequence += 1;
    return { id: sequence, event: String(event['type']), data: { id: sequence, runId: 'run-1', sessionId: 'session-1', seq: sequence, step: 1, createdAt: 1, ...event } as PublicRunEvent };
  };
  const sinkOf = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, sink: createFrameSink({ stdout: { write: (text: string) => void out.push(text) }, stderr: { write: (text: string) => void err.push(text) } } as never, 'text', false) };
  };

  it('prints the approval line, what is unknown, what the recovery found and the command that continues', () => {
    const { sink, err, out } = sinkOf();
    sink.absorb(frame(callOf('c1', 'Write /a.txt')));
    sink.absorb(frame(reconciledOf('c1')));
    sink.handle(frame(asked(['c1'])));
    expect(out).toEqual([]);
    expect(err.join('')).toBe(`momonga: waiting for approval ap1: Effect unknown: Write /a.txt\n${TEXT_ONE.map((line) => `  ${line}\n`).join('')}  momonga approve ap1 allow_once\n`);
    expect(sink.pending()).toBe(1);
    sink.handle(frame({ type: 'tool.unknown.resolved', approvalId: 'ap1', optionId: 'allow_once' }));
    expect(sink.pending()).toBe(0);
  });

  it('counts a cancelled ask as closed', () => {
    const { sink } = sinkOf();
    sink.absorb(frame(callOf('c1', 'Write /a.txt')));
    sink.absorb(frame(reconciledOf('c1')));
    sink.handle(frame(asked(['c1'])));
    sink.handle(frame({ type: 'tool.unknown.cancelled', approvalId: 'ap1', reason: 'withdrawn' }));
    expect(sink.pending()).toBe(0);
  });
});

describe('momonga approve', () => {
  it('lists an unknown effect with its reason lines and its one option', () => {
    expect(
      pendingLines({
        id: 'ap1',
        kind: 'unknown_effect',
        runId: 'r1',
        callId: 'c1',
        status: 'pending',
        options: OPTIONS,
        createdAt: 1,
        reason: TEXT_ONE.join('\n'),
        toolCall: { callId: 'c1', name: 'Write', title: 'Write /a.txt', kind: 'edit' },
      }),
    ).toBe(['ap1  Write /a.txt', ...TEXT_ONE.map((line) => `  ${line}`), '    allow_once  (Continue)'].join('\n'));
  });
});

describe('a child run', () => {
  it('qualifies every call of the ask with the run of the child', () => {
    const event = frameOf('child-1', 3, asked(['c1', 'c2']) as unknown as EventPayload).data;
    expect(asChildEvent(event, 'reviewer')).toMatchObject({ type: 'tool.unknown.requested', callIds: ['child-1/c1', 'child-1/c2'] });
    const resolved = frameOf('child-1', 4, { type: 'tool.unknown.resolved', approvalId: 'ap1', optionId: 'allow_once' } as unknown as EventPayload).data;
    expect(asChildEvent(resolved, 'reviewer')).toBe(resolved);
  });
});

describe('ACP', () => {
  const NONE: ClientFeatures = { notices: false, compaction: false, elicitation: { form: false, url: false } };
  const map = (payload: unknown, state: ReturnType<typeof createMapperState>, seq = 1) => mapRunEvent(frameOf('run-1', seq, payload as EventPayload).data, 'live', state, NONE);

  it('asks about the first call with the title, the text of what is unknown and the one option', () => {
    const state = createMapperState();
    map(callOf('c1', 'Write /a.txt'), state);
    map(callOf('c2', 'Write /b.txt'), state);
    map(reconciledOf('c1'), state);
    map(reconciledOf('c2'), state);
    expect(map(asked(['c1', 'c2']), state)).toEqual([
      {
        kind: 'permission',
        approvalId: 'ap1',
        toolCall: {
          toolCallId: 'run-1/c1',
          title: 'Effect unknown: Write /a.txt and 1 more',
          name: 'Write',
          kind: 'edit',
          status: 'pending',
          rawInput: { file_path: '/a.txt' },
          content: [{ type: 'content', content: { type: 'text', text: TEXT_TWO.join('\n') } }],
        },
        options: OPTIONS,
      },
    ]);
  });

  it('withdraws the request when the ask is answered or cancelled', () => {
    const state = createMapperState();
    expect(map({ type: 'tool.unknown.resolved', approvalId: 'ap1', optionId: 'allow_once' }, state)).toEqual([{ kind: 'withdraw', id: 'ap1' }]);
    expect(map({ type: 'tool.unknown.cancelled', approvalId: 'ap1', reason: 'withdrawn' }, state)).toEqual([{ kind: 'withdraw', id: 'ap1' }]);
  });

  it('refuses an ask about a call nobody announced', () => {
    expect(() => map(asked(['c9']), createMapperState())).toThrow('approval ap1 asks about call c9, which no tool.call event announced');
  });

  it('asks for a call of a child', () => {
    const state = createMapperState();
    const child = (payload: unknown, seq: number) => mapChildEvent(frameOf('child-1', seq, payload as EventPayload).data, 'reviewer', state, NONE);
    child(callOf('c1', 'Write /a.txt'), 1);
    child(reconciledOf('c1'), 2);
    expect(child(asked(['c1']), 3)).toMatchObject([{ kind: 'permission', approvalId: 'ap1', toolCall: { title: 'Effect unknown: reviewer: Write /a.txt', status: 'pending' } }]);
  });
});

describe('the TUI', () => {
  const events = [callOf('c1', 'Write /a.txt'), callOf('c2', 'Write /b.txt'), { type: 'tool.started', callId: 'c1', idemKey: 'k1' }, { type: 'tool.started', callId: 'c2', idemKey: 'k2' }, reconciledOf('c1'), reconciledOf('c2')];

  it('holds the ask as the pending approval until it is answered or cancelled, and keeps the tools marked unknown', () => {
    const pending = fold([...events, asked(['c1', 'c2'])]);
    expect(pending.approval).toEqual({ approvalId: 'ap1', callId: 'c1', options: OPTIONS, reason: UNKNOWN_EFFECT_REASON, unknownCallIds: ['c1', 'c2'] });
    expect(pending.entries.slice(0, 2)).toMatchObject([{ status: 'unknown' }, { status: 'unknown' }]);
    expect(fold([...events, asked(['c1', 'c2']), { type: 'tool.unknown.resolved', approvalId: 'ap1', optionId: 'allow_once' }]).approval).toBeUndefined();
    expect(fold([...events, asked(['c1', 'c2']), { type: 'tool.unknown.cancelled', approvalId: 'ap1', reason: 'withdrawn' }]).approval).toBeUndefined();
  });

  it('shows the panel with its title, what is unknown per call, what the recovery found, and the one row Continue', () => {
    const state = fold([...events, asked(['c1', 'c2'])]);
    const approval = state.approval;
    if (approval === undefined) throw new Error('expected a pending approval');
    const tools = new Map(state.entries.flatMap((entry) => (entry.kind === 'tool' ? [[entry.callId, entry] as const] : [])));
    const text = approvalWording(approval, (callId) => tools.get(callId), '/work');
    expect(text).toEqual({ title: 'Effect unknown: Write /a.txt and 1 more', lines: TEXT_TWO });
    expect(approvalSpec(approval, text.title, text.lines, 1)).toEqual({
      title: 'Effect unknown: Write /a.txt and 1 more',
      lines: TEXT_TWO,
      rows: [{ label: 'Continue' }],
      initial: 0,
      decideOn: 'immediate',
      escape: 'inactive',
      interrupt: 'cancel-run',
      filter: false,
    });
  });

  it('keeps the title and lines of a permission request', () => {
    const requested = { type: 'tool.permission.requested', approvalId: 'ap', callId: 'c1', subjectDigest: 'd', reason: 'edits require approval', options: [{ optionId: 'o', name: 'Allow', kind: 'allow_once' }] };
    const state = fold([callOf('c1', 'Write /a.txt'), requested]);
    const approval = state.approval;
    if (approval === undefined) throw new Error('expected a pending approval');
    const text = approvalWording(approval, () => undefined, '/work');
    expect(text).toEqual({ title: 'c1', lines: ['edits require approval'] });
    expect(approvalSpec(approval, text.title, text.lines, 1).title).toBe('Permission requested: c1');
  });
});
