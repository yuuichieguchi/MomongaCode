import { EventEmitter } from 'node:events';
import { render as inkRender, Text, useInput, usePaste } from 'ink';
import type { Key } from 'ink';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_TOO_SMALL } from '../../src/tui/terminal/constants.ts';
import type { KeyName, TerminalEvent } from '../../src/tui/terminal/events.ts';
import { TerminalFrame } from '../../src/tui/terminal/frame.tsx';
import type { FrameLayer } from '../../src/tui/terminal/frame.tsx';
import { inkInputOf } from '../../src/tui/terminal/ink-bridge.ts';
import { createInkStdin } from '../../src/tui/terminal/ink-stdin.ts';
import type { ScreenRequest, TerminalState } from '../../src/tui/terminal/layer.ts';

const ESC = '\u001b';
const plain = { ctrl: false, alt: false, shift: false };
const named = (name: KeyName, mods: Partial<typeof plain> = {}): TerminalEvent => ({ type: 'key', name, ...plain, ...mods });
const text = (value: string, mods: Partial<typeof plain> = {}): TerminalEvent => ({ type: 'key', text: value, ...plain, ...mods });

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

type Seen = { input: string; key: Key } | { paste: string };

const unmounts: (() => void)[] = [];

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

const mountProbe = async () => {
  const seen: Seen[] = [];
  const Probe = (): ReactNode => {
    useInput((input, key) => {
      seen.push({ input, key });
    });
    usePaste((paste) => {
      seen.push({ paste });
    });
    return <Text>probe</Text>;
  };
  const stdin = createInkStdin();
  const stdout = new FakeStdout();
  const instance = inkRender(<Probe />, { stdin: stdin.stream, stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false });
  unmounts.push(() => instance.unmount());
  await vi.waitFor(() => expect(stdin.stream.listenerCount('readable')).toBe(1));
  const send = async (events: TerminalEvent[], count: number): Promise<Seen[]> => {
    const from = seen.length;
    stdin.push(inkInputOf(events));
    await vi.waitFor(() => expect(seen.length).toBe(from + count));
    return seen.slice(from);
  };
  return { send, seen, stdin };
};

const keyOf = (entry: Seen | undefined): { input: string; key: Key } => {
  if (entry === undefined || 'paste' in entry) throw new Error('expected a key');
  return entry;
};

describe('the encoding of events for Ink', () => {
  it.each([
    ['text', [text('a')], 'a'],
    ['merged text', [text('a'), text('é'), text('あ')], 'aéあ'],
    ['enter', [named('enter')], '\r'],
    ['alt+enter', [named('enter', { alt: true })], `${ESC}\r`],
    ['shift+enter', [named('enter', { shift: true })], `${ESC}[13;2u`],
    ['escape', [named('escape')], `${ESC}[27u`],
    ['tab', [named('tab')], '\t'],
    ['shift+tab', [named('tab', { shift: true })], `${ESC}[Z`],
    ['backspace', [named('backspace')], '\u007f'],
    ['ctrl+c', [text('c', { ctrl: true })], '\u0003'],
    ['ctrl+j', [text('j', { ctrl: true })], '\n'],
    ['ctrl+i', [text('i', { ctrl: true })], `${ESC}[105;5u`],
    ['alt+a', [text('a', { alt: true })], `${ESC}a`],
    ['up', [named('up')], `${ESC}[A`],
    ['ctrl+right', [named('right', { ctrl: true })], `${ESC}[1;5C`],
    ['delete', [named('delete')], `${ESC}[3~`],
    ['shift+delete', [named('delete', { shift: true })], `${ESC}[3;2~`],
    ['f1', [named('f1')], `${ESC}OP`],
    ['f5', [named('f5')], `${ESC}[15~`],
    ['a paste', [{ type: 'paste', text: 'one\ntwo', overflow: false }], `${ESC}[200~one\ntwo${ESC}[201~`],
    ['a mouse report', [{ type: 'mouse', kind: 'press', button: 'left', col: 1, row: 1, ...plain }], ''],
    ['a reply', [{ type: 'report', kind: 'kitty-keys', flags: 7 }], ''],
    ['a focus report', [{ type: 'focus', direction: 'in' }], ''],
  ] as [string, TerminalEvent[], string][])('%s', (_name, events, expected) => {
    expect(inkInputOf(events)).toBe(expected);
  });
});

describe('the existing screen reads its keys through the layer', () => {
  it('receives text, Enter, Shift+Enter and Alt+Enter', async () => {
    const probe = await mountProbe();
    expect(keyOf((await probe.send([text('a')], 1))[0]).input).toBe('a');
    expect(keyOf((await probe.send([named('enter')], 1))[0]).key).toMatchObject({ return: true, shift: false, meta: false });
    expect(keyOf((await probe.send([named('enter', { shift: true })], 1))[0]).key).toMatchObject({ return: true, shift: true });
    expect(keyOf((await probe.send([named('enter', { alt: true })], 1))[0]).key).toMatchObject({ return: true, meta: true });
  });

  it('receives Escape at once and apart from the text after it', async () => {
    const probe = await mountProbe();
    const [first, second] = await probe.send([named('escape'), text('a')], 2);
    expect(keyOf(first).key.escape).toBe(true);
    expect(keyOf(second)).toMatchObject({ input: 'a', key: { escape: false, meta: false } });
  });

  it('receives the control keys, Tab, Shift+Tab, the arrows and Backspace', async () => {
    const probe = await mountProbe();
    expect(keyOf((await probe.send([text('c', { ctrl: true })], 1))[0])).toMatchObject({ input: 'c', key: { ctrl: true } });
    expect(keyOf((await probe.send([text('d', { ctrl: true })], 1))[0])).toMatchObject({ input: 'd', key: { ctrl: true } });
    expect(keyOf((await probe.send([named('tab')], 1))[0]).key).toMatchObject({ tab: true, shift: false });
    expect(keyOf((await probe.send([named('tab', { shift: true })], 1))[0]).key).toMatchObject({ tab: true, shift: true });
    expect(keyOf((await probe.send([named('up')], 1))[0]).key.upArrow).toBe(true);
    expect(keyOf((await probe.send([named('down')], 1))[0]).key.downArrow).toBe(true);
    const backspace = keyOf((await probe.send([named('backspace')], 1))[0]).key;
    expect(backspace.backspace || backspace.delete).toBe(true);
  });

  it('receives a paste on the paste channel and nothing for reports', async () => {
    const probe = await mountProbe();
    const seen = await probe.send([{ type: 'report', kind: 'kitty-keys', flags: 7 }, { type: 'mouse', kind: 'press', button: 'left', col: 1, row: 1, ...plain }, { type: 'paste', text: 'one\r\ntwo', overflow: false }], 1);
    expect(seen).toEqual([{ paste: 'one\r\ntwo' }]);
  });

  it('keeps input pushed before a reader is attached', async () => {
    const stdin = createInkStdin();
    stdin.push('a');
    stdin.push('b');
    const readable = Promise.withResolvers<void>();
    stdin.stream.on('readable', () => readable.resolve());
    await readable.promise;
    expect(stdin.stream.read()).toBe('ab');
    expect(stdin.stream.read()).toBeNull();
  });

  it('is a terminal stream that leaves the real terminal alone', () => {
    const stdin = createInkStdin();
    expect(stdin.stream.isTTY).toBe(true);
    expect(stdin.stream.setRawMode(true)).toBe(stdin.stream);
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

  it('writes a notice above the screen and redraws on request', async () => {
    const fake = fakeLayer(false);
    const app = render(
      <TerminalFrame layer={fake.layer}>
        <Text>hello</Text>
      </TerminalFrame>,
    );
    await vi.waitFor(() => expect(fake.requestListeners()).toBe(1));
    fake.request({ type: 'notice', text: 'The paste was larger than 1 MiB and was not inserted.' });
    await vi.waitFor(() => expect(app.frames.join('\n')).toContain('The paste was larger than 1 MiB and was not inserted.'));
    const before = app.frames.length;
    fake.request({ type: 'redraw' });
    await vi.waitFor(() => expect(app.frames.length).toBeGreaterThan(before));
    expect(app.lastFrame()).toContain('hello');
  });
});
