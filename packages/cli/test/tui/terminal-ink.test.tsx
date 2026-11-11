import { EventEmitter } from 'node:events';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_TOO_SMALL } from '../../src/tui/terminal/constants.ts';
import type { KeyEvent, KeyName } from '../../src/tui/terminal/events.ts';
import { TerminalFrame } from '../../src/tui/terminal/frame.tsx';
import type { FrameLayer } from '../../src/tui/terminal/frame.tsx';
import { createInkStdin } from '../../src/tui/terminal/ink-stdin.ts';
import type { ScreenRequest, TerminalState } from '../../src/tui/terminal/layer.ts';

const plain = { ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false };
const named = (name: KeyName, mods: Partial<typeof plain> = {}): KeyEvent => ({ type: 'key', name, ...plain, ...mods });
const text = (value: string, mods: Partial<typeof plain> = {}): KeyEvent => ({ type: 'key', text: value, ...plain, ...mods });

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  written: string[] = [];
  write = (data: string): boolean => {
    this.written.push(data);
    return true;
  };
}

const unmounts: (() => void)[] = [];

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

describe('the input stream given to Ink', () => {
  it('is a terminal stream that leaves the real terminal alone and never has input', () => {
    const stdin = createInkStdin();
    expect(stdin.stream.isTTY).toBe(true);
    expect(stdin.stream.setRawMode(true)).toBe(stdin.stream);
    expect(stdin.stream.read()).toBeNull();
  });
});

describe('the frame around the screen', () => {
  const fakeLayer = (tooSmall: boolean) => {
    const listeners = new Set<() => void>();
    const requestListeners = new Set<(request: ScreenRequest) => void>();
    let state: Pick<TerminalState, 'tooSmall'> = { tooSmall };
    const layer: FrameLayer = {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      state: () => state,
      subscribeScreen: (listener) => {
        requestListeners.add(listener);
        return () => requestListeners.delete(listener);
      },
      attachInk: () => () => undefined,
    };
    return {
      layer,
      setTooSmall: (value: boolean) => {
        state = { tooSmall: value };
        for (const listener of [...listeners]) listener();
      },
      request: (request: ScreenRequest) => {
        for (const listener of [...requestListeners]) listener(request);
      },
      requestListeners: () => requestListeners.size,
    };
  };

  it('draws the screen unchanged at a usable size', () => {
    const bare = render(<Text>hello</Text>);
    const framed = render(
      <TerminalFrame layer={fakeLayer(false).layer}>
        <Text>hello</Text>
      </TerminalFrame>,
    );
    expect(framed.lastFrame()).toBe(bare.lastFrame());
  });

  it('shows only the too-small line and keeps the state of the screen', async () => {
    const fake = fakeLayer(false);
    let mounts = 0;
    const Screen = (): ReactNode => {
      const [id] = useState(() => {
        mounts += 1;
        return mounts;
      });
      return <Text>screen {id}</Text>;
    };
    const app = render(
      <TerminalFrame layer={fake.layer}>
        <Screen />
      </TerminalFrame>,
    );
    expect(app.lastFrame()).toBe('screen 1');
    fake.setTooSmall(true);
    await vi.waitFor(() => expect(app.lastFrame()).toBe(WINDOW_TOO_SMALL));
    expect(WINDOW_TOO_SMALL).toBe('Window too small');
    fake.setTooSmall(false);
    await vi.waitFor(() => expect(app.lastFrame()).toBe('screen 1'));
    expect(mounts).toBe(1);
  });

  it('leaves a notice to the screen below it and redraws on request', async () => {
    const fake = fakeLayer(false);
    const app = render(
      <TerminalFrame layer={fake.layer}>
        <Text>hello</Text>
      </TerminalFrame>,
    );
    await vi.waitFor(() => expect(fake.requestListeners()).toBe(1));
    fake.request({ type: 'notice', text: 'The paste was larger than 1 MiB and was not inserted.' });
    expect(app.frames.join('\n')).not.toContain('The paste was larger than 1 MiB and was not inserted.');
    const before = app.frames.length;
    fake.request({ type: 'redraw' });
    await vi.waitFor(() => expect(app.frames.length).toBeGreaterThan(before));
    expect(app.lastFrame()).toContain('hello');
  });
});
