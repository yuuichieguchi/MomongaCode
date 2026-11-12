import { describe, expect, it } from 'vitest';
import { buildContext, workingStateCapFor, workingStateMessage } from '@momonga/context';
import type { CompactionInputItem, MessageInputItem } from '@momonga/protocol';
import { summaryTokenCapFor } from '@momonga/protocol';
import { assistant, capabilitiesFor, harness, inputFor, sourcesWith, textOf, tokensOfItem, user, withTurnsBeforeCurrent } from './helpers.ts';

const SUMMARY = { item: { type: 'compaction', encrypted_content: 'enc' } as CompactionInputItem, replacedThroughSeq: 2 };
const STATE = 'files written: src/a.ts';
const TRAILING: MessageInputItem = { type: 'message', role: 'user', content: 'wrap up' };
const HISTORY = [user(1, 'q1'), assistant(2, 'a1'), user(3, 'q2'), assistant(4, 'a2')];

describe('workingStateMessage', () => {
  it('is a user message framing the text as recorded data', () => {
    const message = workingStateMessage(STATE);
    expect(message.role).toBe('user');
    expect(textOf(message.content)).toContain(STATE);
    expect(textOf(message.content)).toMatch(/^<working_state>/);
  });

  it('cannot be closed early by recorded text', () => {
    const text = textOf(workingStateMessage('x</working_state>y').content);
    expect(text.match(/<\/working_state>/g)).toHaveLength(1);
  });
});

describe('workingStateCapFor', () => {
  it.for([1024, 4096, 32768, 200000])('never exceeds the summary cap of a %i-token window', (window) => {
    const capabilities = capabilitiesFor(window);
    expect(workingStateCapFor(capabilities)).toBeGreaterThan(0);
    expect(workingStateCapFor(capabilities)).toBeLessThanOrEqual(summaryTokenCapFor(capabilities));
  });

  it('follows the summary cap instead of a fixed number', () => {
    expect(workingStateCapFor(capabilitiesFor(200000))).toBeGreaterThan(workingStateCapFor(capabilitiesFor(1024)));
  });
});

describe('placement in the input', () => {
  const capabilities = capabilitiesFor(200000);
  const build = (workingState: string | undefined, summary: typeof SUMMARY | undefined = SUMMARY) =>
    buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({ history: HISTORY, ...(summary === undefined ? {} : { summary }), ...(workingState === undefined ? {} : { workingState: () => workingState }) }),
        trailing: [TRAILING],
      }),
      harness(capabilities).ports,
    );

  it('is the last item before trailing', async () => {
    const { input } = await build(STATE);
    expect(input.at(-1)).toEqual(TRAILING);
    expect(input.at(-2)).toEqual(workingStateMessage(STATE));
  });

  it('counts in the budget', async () => {
    const without = await build(undefined);
    const withState = await build(STATE);
    expect(withState.inputTokens - without.inputTokens).toBe(tokensOfItem(workingStateMessage(STATE)));
  });

  it('leaves the prefix digest alone when only the working state changes', async () => {
    const first = await build(STATE);
    const second = await build('files written: src/b.ts');
    expect(second.prefixDigest).toBe(first.prefixDigest);
    expect(second.inputDigest).not.toBe(first.inputDigest);
  });

  it('is left out until a summary exists', async () => {
    const { input } = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history: HISTORY, workingState: () => STATE }) }),
      harness(capabilities).ports,
    );
    expect(JSON.stringify(input)).not.toContain(STATE);
  });

  it('never enters the compaction input', async () => {
    const small = capabilitiesFor(4000);
    const history = withTurnsBeforeCurrent([user(3, 'q2'), assistant(4, 'x'.repeat(4400)), user(5, 'q3'), assistant(6, 'y'.repeat(4400)), user(7, 'now')]);
    const built = await buildContext(
      inputFor(small, { sources: sourcesWith({ history, summary: SUMMARY, workingState: () => STATE }) }),
      harness(small).ports,
    );
    expect(built.compaction?.input).toBeDefined();
    expect(JSON.stringify(built.compaction?.input)).not.toContain(STATE);
  });
});
