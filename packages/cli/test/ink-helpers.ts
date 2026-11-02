import type { ReactElement } from 'react';
import { render } from 'ink-testing-library';

export type Instance = ReturnType<typeof render>;

export const renderObservable = (element: ReactElement): Instance => {
  const instance = render(element);
  const record = instance.stdout.write;
  instance.stdout.write = (frame: string): void => {
    record(frame);
    instance.stdout.emit('write', frame);
  };
  return instance;
};

export const FRAME_BOUND_MS = 10_000;

type Source = (instance: Instance) => string | undefined;

const lastFrameOf: Source = (instance) => instance.lastFrame();

const allOutputOf: Source = (instance) => instance.frames.join('\n');

const until = (source: Source, instance: Instance, pattern: string | RegExp): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const matches = (frame: string | undefined): frame is string => frame !== undefined && (typeof pattern === 'string' ? frame.includes(pattern) : pattern.test(frame));
    const timer = setTimeout(() => {
      instance.stdout.off('write', check);
      reject(new Error(`no frame matched ${String(pattern)} within ${FRAME_BOUND_MS} ms; last frame:\n${instance.lastFrame() ?? ''}`));
    }, FRAME_BOUND_MS);
    const check = (): void => {
      const frame = source(instance);
      if (!matches(frame)) return;
      clearTimeout(timer);
      instance.stdout.off('write', check);
      resolve(frame);
    };
    instance.stdout.on('write', check);
    check();
  });

export const untilFrame = (instance: Instance, pattern: string | RegExp): Promise<string> => until(lastFrameOf, instance, pattern);

export const untilOutput = (instance: Instance, pattern: string | RegExp): Promise<string> => until(allOutputOf, instance, pattern);

export const KEYS = {
  enter: '\r',
  escape: '\u001b',
  shiftTab: '\u001b[Z',
  up: '\u001b[A',
  down: '\u001b[B',
  ctrlC: '\u0003',
  ctrlD: '\u0004',
  ctrlJ: '\n',
} as const;
