import { describe, expect, it } from 'vitest';
import { parseProgressLine, startupSteps } from '@momonga/foundation';
import type { JsonLogger, LogFields } from '@momonga/foundation';

const captureStream = (): { chunks: string[]; stream: { write(chunk: string): boolean } } => {
  const chunks: string[] = [];
  return { chunks, stream: { write: (chunk) => (chunks.push(chunk), true) } };
};

const recordingLogger = (): { logger: JsonLogger; debug: Array<{ msg: string; fields: LogFields | undefined }> } => {
  const debug: Array<{ msg: string; fields: LogFields | undefined }> = [];
  const ignore = (): void => undefined;
  return { debug, logger: { debug: (msg, fields) => void debug.push({ msg, fields }), info: ignore, warn: ignore, error: ignore } };
};

describe('the start-up progress line', () => {
  it('writes one line on the channel of ready and reads it back', async () => {
    const capture = captureStream();
    await startupSteps({ service: 'runtime', pid: 4242, stream: capture.stream, logger: recordingLogger().logger, signal: undefined })('store', () => undefined);
    expect(capture.chunks.join('')).toBe('{"event":"progress","service":"runtime","pid":4242,"step":"store"}\n');
    expect(parseProgressLine(capture.chunks.join(''))).toEqual({ service: 'runtime', pid: 4242, step: 'store' });
  });

  it.each([
    ['non-JSON', 'progress'],
    ['a ready line', '{"event":"ready","service":"runtime","pid":1,"version":"1","socketPath":"/s","startedAt":"t"}'],
    ['string pid', '{"event":"progress","service":"runtime","pid":"1","step":"a"}'],
    ['missing step', '{"event":"progress","service":"runtime","pid":1}'],
    ['JSON null', 'null'],
  ])('refuses %s', (_name, line) => {
    expect(parseProgressLine(line)).toBeUndefined();
  });
});

describe('startupSteps', () => {
  it('announces each step before it runs and returns what the step returns', async () => {
    const capture = captureStream();
    const { logger, debug } = recordingLogger();
    const step = startupSteps({ service: 'gateway', pid: 7, stream: capture.stream, logger, signal: new AbortController().signal });
    const order: string[] = [];
    const value = await step('lock', () => {
      order.push(capture.chunks.join(''));
      return 5;
    });
    expect(value).toBe(5);
    expect(order).toEqual(['{"event":"progress","service":"gateway","pid":7,"step":"lock"}\n']);
    expect(debug).toEqual([{ msg: 'startup.step', fields: { step: 'lock' } }]);
  });

  it('refuses a step once the start is cancelled', async () => {
    const capture = captureStream();
    const controller = new AbortController();
    const step = startupSteps({ service: 'runtime', pid: 7, stream: capture.stream, logger: recordingLogger().logger, signal: controller.signal });
    controller.abort(new Error('cancelled'));
    await expect(step('dirs', () => 1)).rejects.toThrow('cancelled');
    expect(capture.chunks).toEqual([]);
  });
});
