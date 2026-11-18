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

const QUIET = false;
const TYPING = true;

const typedBefore = (gate: ReturnType<typeof createPromptGate>, typing: boolean): void => {
  if (typing) gate.keyPressed();
};

const drawnAs = (gate: ReturnType<typeof createPromptGate>, id: string, typing: boolean): void => {
  typedBefore(gate, typing);
  gate.show(id);
  gate.rendered(id);
  gate.framed();
};

describe('the settle window of a prompt', () => {
  it('takes no key until no key event arrived for the settle, and says when it ended', () => {
    const { clock, gate, changes } = gateOf();
    drawnAs(gate, 'approval:1', QUIET);
    expect(gate.view('approval:1')).toEqual({ drawn: true, settling: true, underHands: false });
    for (const intent of ['enter', 'choice', 'other', 'text'] as const) expect(gate.takes('approval:1', intent, 'key')).toBe(false);
    clock.advance(KEY_SETTLE_MS - 1);
    expect(gate.view('approval:1').settling).toBe(true);
    clock.advance(1);
    expect(gate.view('approval:1')).toEqual({ drawn: true, settling: false, underHands: false });
    expect(changes()).toBe(1);
    for (const intent of ['enter', 'choice', 'other', 'text'] as const) expect(gate.takes('approval:1', intent, 'key')).toBe(true);
  });

  it('stays open while keys keep arriving and ends the settle after the last of them', () => {
    const { clock, gate } = gateOf();
    drawnAs(gate, 'approval:1', QUIET);
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
    drawnAs(gate, 'approval:1', QUIET);
    gate.keyPressed();
    gate.keyReleased();
    expect(gate.view('approval:1').settling).toBe(false);
    expect(changes()).toBe(1);
  });

  it('is shown once for one prompt and starts again for the next', () => {
    const { clock, gate } = gateOf();
    drawnAs(gate, 'approval:1', QUIET);
    clock.advance(KEY_SETTLE_MS);
    drawnAs(gate, 'approval:1', TYPING);
    expect(gate.view('approval:1')).toEqual({ drawn: true, settling: false, underHands: false });
    drawnAs(gate, 'approval:2', QUIET);
    expect(gate.view('approval:2').settling).toBe(true);
    expect(gate.view('approval:1').settling).toBe(true);
  });

  it('leaves no timer behind when the prompt goes away or the gate stops', () => {
    const { clock, gate } = gateOf();
    drawnAs(gate, 'approval:1', QUIET);
    gate.show(undefined);
    expect(clock.pending()).toBe(0);
    gate.keyPressed();
    drawnAs(gate, 'approval:2', QUIET);
    gate.stop();
    expect(clock.pending()).toBe(0);
  });
});

describe('a prompt that appeared under the hands', () => {
  it('is one shown within the settle after a key, and not over a draft typed earlier', () => {
    const drafted = gateOf();
    drawnAs(drafted.gate, 'approval:1', TYPING);
    expect(drafted.gate.view('approval:1').underHands).toBe(true);

    const typed = gateOf();
    typed.gate.keyPressed();
    typed.clock.advance(KEY_SETTLE_MS - 1);
    drawnAs(typed.gate, 'approval:1', QUIET);
    expect(typed.gate.view('approval:1').underHands).toBe(true);

    const calm = gateOf();
    calm.gate.keyPressed();
    calm.clock.advance(KEY_SETTLE_MS);
    drawnAs(calm.gate, 'approval:1', QUIET);
    expect(calm.gate.view('approval:1').underHands).toBe(false);
  });

  it('is never accepted by enter, for its whole life', () => {
    const { clock, gate } = gateOf();
    drawnAs(gate, 'approval:1', TYPING);
    clock.advance(KEY_SETTLE_MS * 100);
    gate.keyPressed();
    expect(gate.takes('approval:1', 'enter', 'key')).toBe(false);
  });

  it('is decided by a digit or a click only when no key event arrived for the settle before it', () => {
    const { clock, gate } = gateOf();
    drawnAs(gate, 'approval:1', TYPING);
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
    drawnAs(gate, 'approval:1', TYPING);
    clock.advance(KEY_SETTLE_MS);
    gate.keyReleased();
    clock.advance(KEY_SETTLE_MS - 1);
    gate.keyPressed();
    expect(gate.takes('approval:1', 'choice', 'key')).toBe(false);
  });

  it('lets the keys that move or decline act once the window ended', () => {
    const { clock, gate } = gateOf();
    drawnAs(gate, 'approval:1', TYPING);
    clock.advance(KEY_SETTLE_MS);
    gate.keyPressed();
    gate.keyPressed();
    expect(gate.takes('approval:1', 'other', 'key')).toBe(true);
  });

  it('takes text for a field only from a key that follows the settle of silence, and from then on', () => {
    const { clock, gate } = gateOf();
    drawnAs(gate, 'input:1', TYPING);
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

describe('a prompt is answered only by a key pressed after its first frame was written', () => {
  it('takes no key, whatever the time, before a frame written after a render that held it', () => {
    const { clock, gate } = gateOf();
    gate.show('approval:1');
    clock.advance(KEY_SETTLE_MS * 10);
    expect(gate.view('approval:1').drawn).toBe(false);
    for (const intent of ['enter', 'choice', 'other', 'text'] as const) expect(gate.takes('approval:1', intent, 'key')).toBe(false);
    gate.framed();
    clock.advance(KEY_SETTLE_MS * 10);
    expect(gate.view('approval:1').drawn).toBe(false);
    gate.rendered('approval:1');
    gate.framed();
    expect(gate.view('approval:1').drawn).toBe(true);
    clock.advance(KEY_SETTLE_MS);
    expect(gate.takes('approval:1', 'enter', 'key')).toBe(true);
  });

  it('is under the hands when a key arrived between its showing and its first frame', () => {
    const { clock, gate } = gateOf();
    gate.show('approval:1');
    gate.rendered('approval:1');
    gate.keyPressed();
    gate.framed();
    clock.advance(KEY_SETTLE_MS);
    expect(gate.view('approval:1')).toEqual({ drawn: true, settling: false, underHands: true });
    expect(gate.takes('approval:1', 'enter', 'key')).toBe(false);
  });

  it('does not end its window at the release of a key pressed before its frame', () => {
    const { gate } = gateOf();
    gate.keyPressed();
    drawnAs(gate, 'approval:1', QUIET);
    gate.keyReleased();
    expect(gate.view('approval:1').settling).toBe(true);
  });

  it('goes under the hands when text it has no use for is typed at it', () => {
    const { clock, gate, changes } = gateOf();
    drawnAs(gate, 'approval:1', QUIET);
    clock.advance(KEY_SETTLE_MS);
    const before = changes();
    gate.typedAside('approval:1');
    expect(gate.view('approval:1').underHands).toBe(true);
    expect(changes()).toBe(before + 1);
    expect(gate.takes('approval:1', 'enter', 'key')).toBe(false);
  });

  it('does not count the key that submitted the input as typing toward the next prompt', () => {
    const { gate } = gateOf();
    gate.keyPressed();
    gate.keyConsumed();
    drawnAs(gate, 'pick:1', QUIET);
    expect(gate.view('pick:1').underHands).toBe(false);
  });
});
