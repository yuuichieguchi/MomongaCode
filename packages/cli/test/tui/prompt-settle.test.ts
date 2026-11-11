import { describe, expect, it } from 'vitest';
import { createPromptGate } from '../../src/tui/screen/prompt-settle.ts';
import { KEY_SETTLE_MS } from '../../src/tui/terminal/constants.ts';
import { manualClock } from './screen-clock.ts';

const gateOf = () => {
  const clock = manualClock();
  let changes = 0;
  const gate = createPromptGate({ timers: clock.timers, settleMs: KEY_SETTLE_MS, onChange: () => void (changes += 1) });
  return { clock, gate, changes: () => changes };
};

const NO_DRAFT = false;
const DRAFT = true;

describe('the settle window of a prompt', () => {
  it('takes no key until no key event arrived for the settle, and says when it ended', () => {
    const { clock, gate, changes } = gateOf();
    gate.show('approval:1', NO_DRAFT);
    expect(gate.view('approval:1')).toEqual({ settling: true, underHands: false });
    for (const intent of ['enter', 'choice', 'other', 'text'] as const) expect(gate.takes('approval:1', intent, 'key')).toBe(false);
    clock.advance(KEY_SETTLE_MS - 1);
    expect(gate.view('approval:1').settling).toBe(true);
    clock.advance(1);
    expect(gate.view('approval:1')).toEqual({ settling: false, underHands: false });
    expect(changes()).toBe(1);
    for (const intent of ['enter', 'choice', 'other', 'text'] as const) expect(gate.takes('approval:1', intent, 'key')).toBe(true);
  });

  it('stays open while keys keep arriving and ends the settle after the last of them', () => {
    const { clock, gate } = gateOf();
    gate.show('approval:1', NO_DRAFT);
    for (let key = 0; key < 5; key += 1) {
      clock.advance(KEY_SETTLE_MS - 1);
      gate.keyPressed();
      expect(gate.takes('approval:1', 'choice', 'key')).toBe(false);
    }
    clock.advance(KEY_SETTLE_MS);
    gate.keyPressed();
    expect(gate.takes('approval:1', 'choice', 'key')).toBe(true);
  });

  it('ends at once at a key release, on a terminal that reports releases', () => {
    const { gate, changes } = gateOf();
    gate.keyPressed();
    gate.show('approval:1', NO_DRAFT);
    gate.keyReleased();
    expect(gate.view('approval:1').settling).toBe(false);
    expect(changes()).toBe(1);
  });

  it('is shown once for one prompt and starts again for the next', () => {
    const { clock, gate } = gateOf();
    gate.show('approval:1', NO_DRAFT);
    clock.advance(KEY_SETTLE_MS);
    gate.show('approval:1', DRAFT);
    expect(gate.view('approval:1')).toEqual({ settling: false, underHands: false });
    gate.show('approval:2', NO_DRAFT);
    expect(gate.view('approval:2').settling).toBe(true);
    expect(gate.view('approval:1').settling).toBe(true);
  });

  it('leaves no timer behind when the prompt goes away or the gate stops', () => {
    const { clock, gate } = gateOf();
    gate.show('approval:1', NO_DRAFT);
    gate.show(undefined, NO_DRAFT);
    expect(clock.pending()).toBe(0);
    gate.keyPressed();
    gate.show('approval:2', NO_DRAFT);
    gate.stop();
    expect(clock.pending()).toBe(0);
  });
});

describe('a prompt that appeared under the hands', () => {
  it('is one shown while the editor holds a draft, or within the settle after a key', () => {
    const drafted = gateOf();
    drafted.gate.show('approval:1', DRAFT);
    expect(drafted.gate.view('approval:1').underHands).toBe(true);

    const typed = gateOf();
    typed.gate.keyPressed();
    typed.clock.advance(KEY_SETTLE_MS - 1);
    typed.gate.show('approval:1', NO_DRAFT);
    expect(typed.gate.view('approval:1').underHands).toBe(true);

    const calm = gateOf();
    calm.gate.keyPressed();
    calm.clock.advance(KEY_SETTLE_MS);
    calm.gate.show('approval:1', NO_DRAFT);
    expect(calm.gate.view('approval:1').underHands).toBe(false);
  });

  it('is never accepted by enter, for its whole life', () => {
    const { clock, gate } = gateOf();
    gate.show('approval:1', DRAFT);
    clock.advance(KEY_SETTLE_MS * 100);
    gate.keyPressed();
    expect(gate.takes('approval:1', 'enter', 'key')).toBe(false);
  });

  it('is decided by a digit or a click only when no key event arrived for the settle before it', () => {
    const { clock, gate } = gateOf();
    gate.show('approval:1', DRAFT);
    clock.advance(KEY_SETTLE_MS);
    gate.keyPressed();
    expect(gate.takes('approval:1', 'choice', 'key')).toBe(true);
    clock.advance(KEY_SETTLE_MS - 1);
    gate.keyPressed();
    expect(gate.takes('approval:1', 'choice', 'key')).toBe(false);
    expect(gate.takes('approval:1', 'choice', 'pointer')).toBe(false);
    clock.advance(KEY_SETTLE_MS);
    expect(gate.takes('approval:1', 'choice', 'pointer')).toBe(true);
  });

  it('counts a key release as a key event before a digit', () => {
    const { clock, gate } = gateOf();
    gate.show('approval:1', DRAFT);
    clock.advance(KEY_SETTLE_MS);
    gate.keyReleased();
    clock.advance(KEY_SETTLE_MS - 1);
    gate.keyPressed();
    expect(gate.takes('approval:1', 'choice', 'key')).toBe(false);
  });

  it('lets the keys that move or decline act once the window ended', () => {
    const { clock, gate } = gateOf();
    gate.show('approval:1', DRAFT);
    clock.advance(KEY_SETTLE_MS);
    gate.keyPressed();
    gate.keyPressed();
    expect(gate.takes('approval:1', 'other', 'key')).toBe(true);
  });

  it('takes text for a field only from a key that follows the settle of silence, and from then on', () => {
    const { clock, gate } = gateOf();
    gate.show('input:1', DRAFT);
    gate.keyReleased();
    gate.keyPressed();
    expect(gate.takes('input:1', 'text', 'key')).toBe(false);
    clock.advance(KEY_SETTLE_MS);
    gate.keyPressed();
    expect(gate.takes('input:1', 'text', 'key')).toBe(true);
    gate.keyPressed();
    expect(gate.takes('input:1', 'text', 'key')).toBe(true);
  });
});
