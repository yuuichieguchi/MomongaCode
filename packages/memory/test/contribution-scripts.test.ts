import { describe, expect, it } from 'vitest';
import { measureContribution } from '@momonga/memory';
import type { InjectedItem } from '@momonga/memory';
import { hasToken, occursIn, tokensOf } from '../src/contribution.ts';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';

const journal = (payloads: readonly RunEventPayload[]): RunEvent[] =>
  payloads.map((payload, index) => ({ ...payload, id: index + 1, runId: 'run-c', sessionId: 's', seq: index + 1, step: 1, leaseToken: 1, createdAt: 1 }) as RunEvent);

const said = (step: number, text: string): RunEventPayload =>
  ({
    type: 'model.responded',
    step,
    attempt: 1,
    response: { status: 'completed', output: [{ type: 'message', id: `m${step}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  }) as RunEventPayload;

const item = (text: string, overrides: Partial<InjectedItem> = {}): InjectedItem => ({ kind: 'memory', id: 'q1', text, fromSeq: 0, ...overrides });

const contributed = (payloads: readonly RunEventPayload[], injected: InjectedItem, task = 'タスクの説明'): boolean =>
  measureContribution({ events: journal(payloads), task, injected: [injected] })[0]?.contributed ?? false;

describe('hasToken', () => {
  it('agrees with whole-text tokenization on random mixed text', () => {
    let state = 20_260_413;
    const below = (limit: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.floor((state / 0x100000000) * limit);
    };
    const pieces = ['zorpLauncher', 'qa/b.ts', 'src/qa/b.ts', 'note-q7', 'a.b', 'b.ts', 'handler_2', '設定ファイル', '環境変数', 'を', 'ビルド手順', 'x', '12345', '/', '.', '-', ' ', ' ', '\n', ',', '、', '。', '(', 'zorp', 'Launcher'];
    const textOf = (): string => Array.from({ length: 3 + below(14) }, () => pieces[below(pieces.length)]).join(below(2) === 0 ? '' : ' ');
    for (let round = 0; round < 3000; round += 1) {
      const text = textOf();
      const candidates = [...tokensOf(textOf()), ...tokensOf(text)];
      const identifier = candidates[below(candidates.length)] ?? 'zorpLauncher';
      expect(hasToken(text, identifier), JSON.stringify({ text, identifier })).toBe(occursIn([tokensOf(text)], identifier));
    }
  });
});

describe('measureContribution with non-ASCII text', () => {
  it('credits a Japanese note whose word first appears in a step', () => {
    expect(contributed([said(1, 'ファイルを確認します')], item('設定ファイルを読む'))).toBe(true);
  });

  it('credits a Japanese word of exactly six UTF-8 bytes and not one of three', () => {
    expect(contributed([said(1, '設定を見る')], item('設定'))).toBe(true);
    expect(contributed([said(1, '設を見る')], item('設'))).toBe(false);
  });

  it('gives nothing for a Japanese word the task already named', () => {
    expect(contributed([said(1, 'ファイルを確認')], item('ファイルを読む'), 'ファイルを直す')).toBe(false);
  });

  it('gives nothing for a Japanese word in an earlier tool output', () => {
    const output: RunEventPayload = { type: 'tool.completed', callId: 'c0', status: 'completed', output: 'ファイルの一覧' };
    expect(contributed([output, said(2, 'ファイルを確認')], item('ファイルを読む'))).toBe(false);
  });

  it('credits a Japanese word replaced by compaction, as it does an ASCII one', () => {
    const output: RunEventPayload = { type: 'tool.completed', callId: 'c0', status: 'completed', output: 'ファイルの一覧' };
    const compaction: RunEventPayload = { type: 'context.compacted', item: { type: 'message', role: 'user', content: 's' }, summary: 's', replacedThroughSeq: 1 };
    expect(contributed([output, compaction, said(2, 'ファイルを確認')], item('ファイルを読む', { kind: 'summary', id: 'summary-2', fromSeq: 2 }))).toBe(true);
  });

  it('never credits a particle alone', () => {
    expect(contributed([said(1, 'を')], item('を'))).toBe(false);
  });

  it('credits an identifier in mixed text', () => {
    expect(contributed([said(1, '実行する zorpLauncher を呼ぶ')], item('zorpLauncher を実行'))).toBe(true);
    expect(contributed([said(1, '実行する')], item('zorpLauncher を実行'))).toBe(true);
    expect(contributed([said(1, 'zorpLauncher')], item('zorpLauncherを実行'))).toBe(true);
  });

  it('does not credit a different Japanese word', () => {
    expect(contributed([said(1, '環境変数を確認')], item('設定ファイルを読む'))).toBe(false);
  });

  it('scans a long non-ASCII run in linear time', () => {
    const started = performance.now();
    const long = '設定'.repeat(100_000);
    measureContribution({ events: journal([said(1, long)]), task: 'task', injected: [item('設定ファイル')] });
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('never changes the result when an item is added whose identifiers all appear earlier', () => {
    let state = 20_260_412;
    const below = (limit: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.floor((state / 0x100000000) * limit);
    };
    const pool = ['設定ファイル', '環境変数', '依頼内容', 'ビルド手順', 'zorpTool', '検証コマンド', 'テスト結果', '実装方針'];
    const pick = (): string => pool[below(pool.length)] as string;
    for (let round = 0; round < 200; round += 1) {
      const known = [pick(), pick(), pick()];
      const task = `作業対象 ${known.join(' ')}`;
      const payloads = Array.from({ length: 1 + below(5) }, (_unused, index) => said(index + 1, `${pick()} ${pick()}`));
      const events = journal(payloads);
      const injected = [item(`メモ ${pick()}`, { id: 'q1' }), item(`メモ ${pick()} ${pick()}`, { id: 'q2', kind: 'governing' })];
      const decoy = item(known.join(' '), { id: 'q3', kind: 'working_state' });
      const without = measureContribution({ events, task, injected });
      const withDecoy = measureContribution({ events, task, injected: [...injected, decoy] });
      expect(withDecoy.slice(0, 2)).toEqual(without);
      expect(withDecoy[2]).toEqual({ kind: 'working_state', id: 'q3', contributed: false });
    }
  });
});
