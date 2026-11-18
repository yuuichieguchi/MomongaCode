import { isValidElement } from 'react';
import type { ReactElement } from 'react';
import { render } from 'ink-testing-library';
import { systemTiming } from '@momonga/foundation';
import type { TerminalEvent } from '../src/tui/terminal/events.ts';
import { createInputParser } from '../src/tui/terminal/parser.ts';

export type Instance = ReturnType<typeof render>;

type TypedInto = { emit(event: TerminalEvent): boolean; framed?: () => void };

const LONE_ESCAPE = '\u001b';
const ESCAPE_KEY = '\u001b[27u';

const isTypedInto = (value: unknown): value is TypedInto => typeof value === 'object' && value !== null && 'emit' in value && 'input' in value;

const terminalOf = (node: unknown): TypedInto | undefined => {
  if (Array.isArray(node)) return node.map(terminalOf).find((found) => found !== undefined);
  if (!isValidElement<{ terminal?: unknown; children?: unknown }>(node)) return undefined;
  return isTypedInto(node.props.terminal) ? node.props.terminal : terminalOf(node.props.children);
};

export const renderObservable = (element: ReactElement): Instance => {
  const instance = render(element);
  const terminal = terminalOf(element);
  if (terminal !== undefined) {
    const parser = createInputParser();
    instance.stdin.write = (text: string): void => {
      for (const event of parser.push(Buffer.from(text === LONE_ESCAPE ? ESCAPE_KEY : text, 'utf8'))) terminal.emit(event);
    };
  }
  const record = instance.stdout.write;
  const write = (frame: string, written?: () => void): void => {
    terminal?.framed?.();
    if (frame !== '' || written === undefined) {
      record(frame);
      instance.stdout.emit('write', frame);
    }
    written?.();
  };
  instance.stdout.write = write;
  return instance;
};

type TestTimers = { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };

type AtOnce = { cancelled: boolean };

const isAtOnce = (handle: unknown): handle is AtOnce => typeof handle === 'object' && handle !== null && 'cancelled' in handle;

export const TEST_KEY_SETTLE_MS = 0.5;

export const settleAtOnce = <T extends TestTimers>(timers: T): T => ({
  ...timers,
  setTimeout: (run: () => void, ms: number): unknown => {
    if (ms !== TEST_KEY_SETTLE_MS) return timers.setTimeout(run, ms);
    const handle: AtOnce = { cancelled: false };
    queueMicrotask(() => {
      if (!handle.cancelled) run();
    });
    return handle;
  },
  clearTimeout: (handle: unknown): void => {
    if (isAtOnce(handle)) handle.cancelled = true;
    else timers.clearTimeout(handle);
  },
});

export const FRAME_BOUND_MS = 10_000;

export const TUI_TEST_TIMEOUT_MS = FRAME_BOUND_MS * 4;

type Source = (instance: Instance) => string | undefined;

const lastFrameOf: Source = (instance) => instance.lastFrame();

const allOutputOf: Source = (instance) => instance.frames.join('\n');

export type FramePattern = string | RegExp | ((frame: string) => boolean);

const until = (source: Source, instance: Instance, pattern: FramePattern): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const matches = (frame: string | undefined): frame is string => frame !== undefined && (typeof pattern === 'string' ? frame.includes(pattern) : typeof pattern === 'function' ? pattern(frame) : pattern.test(frame));
    const timer = systemTiming.setTimeout(() => {
      instance.stdout.off('write', check);
      reject(new Error(`no frame matched ${String(pattern)} within ${FRAME_BOUND_MS} ms; last frame:\n${instance.lastFrame() ?? ''}`));
    }, FRAME_BOUND_MS);
    const check = (): void => {
      const frame = source(instance);
      if (!matches(frame)) return;
      systemTiming.clearTimeout(timer);
      instance.stdout.off('write', check);
      resolve(frame);
    };
    instance.stdout.on('write', check);
    check();
  });

export const untilFrame = (instance: Instance, pattern: FramePattern): Promise<string> => until(lastFrameOf, instance, pattern);

export const untilOutput = (instance: Instance, pattern: FramePattern): Promise<string> => until(allOutputOf, instance, pattern);

export const withoutLinks = (output: string): string => output.replace(/\u001b\]8;;[^\u0007]*\u0007/g, '');

export const KEYS = {
  enter: '\r',
  escape: '\u001b',
  shiftTab: '\u001b[Z',
  up: '\u001b[A',
  down: '\u001b[B',
  ctrlC: '\u0003',
  ctrlD: '\u0004',
  ctrlJ: '\n',
  shiftEnter: '\u001b[13;2u',
  altEnter: '\u001b\r',
  backspace: '\u007f',
  delete: '\u001b[3~',
  left: '\u001b[D',
  right: '\u001b[C',
  home: '\u001b[H',
  end: '\u001b[F',
  tab: '\t',
  ctrlA: '\u0001',
  ctrlE: '\u0005',
  ctrlG: '\u0007',
  ctrlK: '\u000b',
  ctrlL: '\u000c',
  ctrlO: '\u000f',
  ctrlR: '\u0012',
  ctrlU: '\u0015',
  ctrlV: '\u0016',
  ctrlW: '\u0017',
  ctrlX: '\u0018',
  ctrlY: '\u0019',
  ctrlUnderscore: '\u001f',
  altB: '\u001bb',
  altF: '\u001bf',
  altD: '\u001bd',
  altLeft: '\u001b[1;3D',
  altRight: '\u001b[1;3C',
  ctrlLeft: '\u001b[1;5D',
  ctrlRight: '\u001b[1;5C',
  pasteStart: '\u001b[200~',
  pasteEnd: '\u001b[201~',
} as const;
