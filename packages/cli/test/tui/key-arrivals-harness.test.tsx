import { describe, expect, it } from 'vitest';
import { KEY_SETTLE_MS } from '../../src/tui/terminal/constants.ts';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';
import { KEYS } from '../ink-helpers.ts';
import { startAtRealTiming } from './keys-shown-screen.tsx';
import { SIGNED_IN } from './keys-shown-screen-cases.tsx';
import { manualClock } from './screen-clock.ts';
import { throughTheLayer } from './screen-fakes.ts';

const recorder = () => {
  const seen: string[] = [];
  const name = (event: TerminalEvent): string => (event.type !== 'key' ? event.type : 'name' in event ? event.name : event.text);
  return { seen, terminal: { arrived: () => void seen.push('arrival'), push: (events: readonly TerminalEvent[]) => void seen.push(...events.map(name)) } };
};

describe('test keys reach the product the way the terminal layer delivers them', () => {
  it('one write is one arrival before its keys', () => {
    const clock = manualClock();
    const { seen, terminal } = recorder();
    throughTheLayer(terminal, clock.timers)(`a${KEYS.enter}`);
    expect(seen).toEqual(['arrival', 'a', 'enter']);
  });

  it('enter and a lone esc in one write: one arrival, the enter at once, the esc only when the parser hold ends, with no second arrival', () => {
    const clock = manualClock();
    const { seen, terminal } = recorder();
    throughTheLayer(terminal, clock.timers)(`${KEYS.enter}${KEYS.escape}`);
    expect(seen).toEqual(['arrival', 'enter']);
    clock.advance(KEY_SETTLE_MS - 1);
    expect(seen).toEqual(['arrival', 'enter']);
    clock.advance(1);
    expect(seen).toEqual(['arrival', 'enter', 'escape']);
  });

  it('the product listens to the arrivals of the test terminal', async () => {
    const driver = await startAtRealTiming(SIGNED_IN);
    expect(driver.terminal.arrivalWatchers()).toBe(1);
    driver.app.unmount();
  });
});
