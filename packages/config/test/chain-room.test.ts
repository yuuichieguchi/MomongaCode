import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import { loadModelsSection } from './load-models.ts';

type Facts = { outputBounded: boolean; contextWindow: number | undefined; maxOutputTokens: number | undefined };
type Member = { model: string; facts: Facts; measuring: boolean };
type Refusal =
  | { kind: 'unknown_room'; first: string; unbounded: string; other: string }
  | { kind: 'small_room'; first: string; unboundedOutputTokens: number; minWindow: number; margin: number; room: number; required: number };
type Verdict = { kind: 'serve' } | { kind: 'wait' } | { kind: 'refuse'; refusal: Refusal };

const exported = <T>(name: string): T => {
  const value = (config as Record<string, unknown>)[name];
  if (typeof value !== 'function') throw new Error(`@momonga/config does not export ${name} (packages/config/src/chain-room.ts)`);
  return value as T;
};

const chainRoomVerdict = (first: string, members: readonly Member[]): Verdict => exported<(first: string, members: readonly Member[]) => Verdict>('chainRoomVerdict')(first, members);
const roomVerdictText = (refusal: Refusal, displayOf: (canon: string) => string): string => exported<(refusal: Refusal, displayOf: (canon: string) => string) => string>('roomVerdictText')(refusal, displayOf);

const REMOTE = 'openai/remote-model';
const APPLE = 'apple/apple-model';
const BANANA = 'srv-127.0.0.1-8080/banana-model';

const DISPLAY: Readonly<Record<string, string>> = { [REMOTE]: 'remote-model', [APPLE]: 'apple-model', [BANANA]: 'banana-model' };
const displayOf = (canon: string): string => DISPLAY[canon] ?? `no display name for ${canon}`;

const member = (model: string, values: Partial<Facts> & { measuring?: boolean }): Member => {
  const { measuring = false, ...facts } = values;
  return { model, facts: { outputBounded: true, contextWindow: undefined, maxOutputTokens: undefined, ...facts }, measuring };
};

const unboundedRemote = member(REMOTE, { outputBounded: false, contextWindow: 100_000, maxOutputTokens: 1_000 });

describe('chainRoomVerdict: the input room of a model and the models it falls back to', () => {
  it('serves a chain whose members are all output-bounded, whatever their windows', () => {
    expect(chainRoomVerdict(APPLE, [member(APPLE, {}), member(BANANA, {})])).toEqual({ kind: 'serve' });
  });

  it('serves a chain with an unbounded member once every member value is known and the room is enough', () => {
    expect(chainRoomVerdict(REMOTE, [unboundedRemote, member(APPLE, { contextWindow: 100_000, maxOutputTokens: 1_000 })])).toEqual({ kind: 'serve' });
  });

  it('makes the chain wait while a member whose values are missing is being measured, so no guessed value is used', () => {
    expect(chainRoomVerdict(REMOTE, [unboundedRemote, member(APPLE, { measuring: true })])).toEqual({ kind: 'wait' });
  });

  it('refuses when a member value is still unknown after its probe; the verdict holds the references and the sentence the display names', () => {
    const verdict = chainRoomVerdict(REMOTE, [unboundedRemote, member(APPLE, { contextWindow: 8_192 })]);
    expect(verdict).toEqual({ kind: 'refuse', refusal: { kind: 'unknown_room', first: REMOTE, unbounded: REMOTE, other: APPLE } });
    if (verdict.kind !== 'refuse') return;
    expect(roomVerdictText(verdict.refusal, displayOf)).toBe(
      'remote-model: remote-model has no output bound, and apple-model neither declares nor reports a contextWindow or maxOutputTokens, so the input room of remote-model and the models it falls back to cannot be known',
    );
  });

  it('refuses a known room that is too small for input; the verdict holds the five numbers and the sentence shows four of them', () => {
    const verdict = chainRoomVerdict(BANANA, [member(BANANA, { contextWindow: 8_192, maxOutputTokens: 8_000 }), member(REMOTE, { outputBounded: false, contextWindow: 8_192, maxOutputTokens: 8_000 })]);
    expect(verdict).toEqual({ kind: 'refuse', refusal: { kind: 'small_room', first: BANANA, unboundedOutputTokens: 8_000, minWindow: 8_192, margin: 164, room: 28, required: 2_048 } });
    if (verdict.kind !== 'refuse') return;
    expect(roomVerdictText(verdict.refusal, displayOf)).toBe(
      'banana-model and the models it falls back to include a model that carries no output bound (outputBoundField none), so any of them can emit up to 8000 tokens; with the smallest context window 8192 only 28 tokens of input remain, below the 2048 required',
    );
  });
});

const CAPABILITIES = { contextWindow: 100_000, maxOutputTokens: 1_000 };

const roomWarnings = (warnings: readonly string[]): string[] => warnings.filter((warning) => warning.includes('leave no room for the input'));

describe('the room of a chain at load', () => {
  it('a chain whose values are measured after the load is not judged: the file loads without a room warning', async () => {
    const { models, warnings } = await loadModelsSection({
      connections: [
        { adapter: 'chat-completions', provider: 'remote', baseUrl: 'https://api.example.com/v1', models: [{ id: 'm', capabilities: CAPABILITIES }] },
        { adapter: 'managed', server: 'fm', models: [{ id: 'x' }] },
        { adapter: 'open-responses', plan: { profile: 'chatgpt' }, models: [{ id: 'gpt-5.5' }] },
      ],
      fallback: ['apple/x', 'chatgpt/gpt-5.5'],
      billingChanges: [{ from: 'metered', to: 'local' }, { from: 'local', to: 'plan' }, { from: 'metered', to: 'plan' }],
    });
    expect([...models.models.keys()]).toEqual(['remote/m', 'apple/x', 'chatgpt/gpt-5.5']);
    expect(models.chains.get('remote/m')).toEqual(['remote/m', 'apple/x', 'chatgpt/gpt-5.5']);
    expect(roomWarnings(warnings)).toEqual([]);
  });

  it('an unsafe chain whose members all declare their numbers is a warning with the numbers of the verdict, and the file loads', async () => {
    const { file, models, warnings } = await loadModelsSection({
      connections: [{ adapter: 'open-responses', plan: { profile: 'chatgpt' }, models: [{ id: 'gpt-5.5', capabilities: { contextWindow: 100_000, maxOutputTokens: 90_000 } }] }],
    });
    expect([...models.models.keys()]).toEqual(['chatgpt/gpt-5.5']);
    const [warning, ...rest] = roomWarnings(warnings);
    expect(rest).toEqual([]);
    const opening = `${file}: models.fallback: gpt-5.5 and the models it falls back to leave no room for the input (`;
    const closing = '); requests to gpt-5.5 will be refused until a window is declared';
    expect(warning?.startsWith(opening)).toBe(true);
    expect(warning?.endsWith(closing)).toBe(true);
    const numbers = (warning ?? '').slice(opening.length, -closing.length).match(/\d+/g) ?? [];
    expect([...numbers].sort()).toEqual(['90000', '100000', '2000', '8000', '25000'].sort());
  });
});
