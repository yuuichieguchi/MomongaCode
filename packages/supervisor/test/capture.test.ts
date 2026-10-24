import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createFakeClock, withTempDir } from '@momonga/testkit';
import { createJsonLogger, formatLogLine, momongaPaths } from '@momonga/foundation';
import { captureStream, createOutputLimiter, DEFAULT_OUTPUT_LIMITS, truncateRaw } from '../src/capture.ts';
import { OUTPUT_MAX_BYTES_PER_MINUTE } from '../src/constants.ts';
import type { OutputLimiter } from '../src/capture.ts';
import { createLogBuffer } from './support/p2-log-buffer.ts';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const unlimited: OutputLimiter = { admit: () => true, flush: () => undefined };

const capture = async (input: string | Buffer[], kind: 'stdout' | 'stderr', options: { consume?: (line: string) => boolean } = {}) => {
  const clock = createFakeClock(T0);
  const log = createLogBuffer(clock);
  const stream = new PassThrough();
  const done = captureStream({
    stream,
    kind,
    role: 'runtime',
    childPid: 4242,
    service: 'supervisor',
    logger: log.logger,
    limiter: unlimited,
    ...(options.consume === undefined ? {} : { consume: options.consume }),
  });
  for (const chunk of typeof input === 'string' ? [Buffer.from(input)] : input) stream.write(chunk);
  stream.end();
  await done;
  return log;
};

describe('raw part truncation', () => {
  it('raw is truncated at 8 KiB, visibly and on a character boundary', () => {
    const line = `${'€'.repeat(21_845)}a`;
    expect(Buffer.byteLength(line)).toBe(65_536);
    const part = truncateRaw(line);
    expect(part.rawBytes).toBe(65_536);
    expect(part.truncated).toBe(true);
    expect(Buffer.byteLength(part.raw)).toBe(8190);
    expect(part.raw).toBe('€'.repeat(2730));
    expect(part.raw).not.toContain('�');
    const short = 'x'.repeat(100);
    const shortPart = truncateRaw(short);
    expect(shortPart).toEqual({ raw: short, rawBytes: 100 });
    expect('truncated' in shortPart).toBe(false);
  });

  it('a part of exactly 8 KiB is not truncated', () => {
    const exact = 'y'.repeat(8192);
    expect(truncateRaw(exact)).toEqual({ raw: exact, rawBytes: 8192 });
  });
});

describe('capture wrapping', () => {
  it('a JSON stderr line is wrapped, not passed through', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const input = JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', level: 'error', service: 'runtime', pid: 1, msg: 'entry.fatal' });
    const log = await capture(`${input}\n`, 'stderr');
    const lines = log.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'child.stderr', level: 'warn', service: 'supervisor', pid: process.pid, child: 'runtime', childPid: 4242, raw: input, rawBytes: Buffer.byteLength(input) });
    const paths = momongaPaths(home, process.platform, {});
    expect(fs.existsSync(paths.logFiles.runtime)).toBe(false);
  });

  it('a non-JSON line is wrapped', async () => {
    const log = await capture('    at Object.<anonymous> (/x/y.js:1:1)\n', 'stderr');
    expect(log.lines()).toEqual([
      expect.objectContaining({ level: 'warn', msg: 'child.stderr', child: 'runtime', childPid: 4242, raw: '    at Object.<anonymous> (/x/y.js:1:1)', rawBytes: 39 }),
    ]);
    expect(log.lines()[0]).not.toHaveProperty('truncated');
  });

  it('stdout other than the ready line is wrapped as child.stdout', async () => {
    const seen: string[] = [];
    const log = await capture('READY-LINE\nstray output\n', 'stdout', {
      consume: (line) => {
        seen.push(line);
        return line === 'READY-LINE';
      },
    });
    expect(seen).toEqual(['READY-LINE', 'stray output']);
    expect(log.lines()).toEqual([expect.objectContaining({ level: 'info', msg: 'child.stdout', child: 'runtime', childPid: 4242, raw: 'stray output', rawBytes: 12 })]);
  });

  it('overlong line is split and each part is valid JSON', async () => {
    const log = await capture(`${'a'.repeat(204_800)}\n`, 'stderr');
    const lines = log.lines();
    expect(lines.map((line) => line['rawBytes'])).toEqual([65_536, 65_536, 65_536, 8192]);
    expect(lines.map((line) => (line['raw'] as string).length)).toEqual([8192, 8192, 8192, 8192]);
    expect(lines.map((line) => line['truncated'])).toEqual([true, true, true, undefined]);
    for (const line of lines) expect(line['msg']).toBe('child.stderr');
  });

  it('partial last line is flushed on exit', async () => {
    const log = await capture('first\nno newline at the end', 'stderr');
    expect(log.lines().map((line) => line['raw'])).toEqual(['first', 'no newline at the end']);
  });

  it('multi-byte characters split across chunks decode correctly', async () => {
    const bytes = Buffer.from('naïve €\n');
    const log = await capture([bytes.subarray(0, 4), bytes.subarray(4, 8), bytes.subarray(8)], 'stderr');
    expect(log.lines().map((line) => line['raw'])).toEqual(['naïve €']);
  });

  it('capture keeps consuming when the sink drops', async () => {
    const clock = createFakeClock(T0);
    const log = createLogBuffer(clock, { accept: false });
    const stream = new PassThrough({ highWaterMark: 1024 });
    const done = captureStream({ stream, kind: 'stderr', role: 'gateway', childPid: 7, service: 'supervisor', logger: log.logger, limiter: unlimited });
    const line = `${'z'.repeat(1023)}\n`;
    for (let index = 0; index < 2048; index += 1) stream.write(line);
    stream.end();
    await done;
    expect(stream.readableEnded).toBe(true);
    expect(log.writes()).toBe(2048);
  });
});

describe('output limiter', () => {
  it('uses the fixed limits by default', () => {
    expect(DEFAULT_OUTPUT_LIMITS).toEqual({ maxLinesPerSecond: 200, maxBytesPerMinute: 1_048_576 });
  });

  it('admits 200 lines in one second and summarises the rest once', () => {
    const clock = createFakeClock(T0);
    const log = createLogBuffer(clock);
    const limiter = createOutputLimiter({ role: 'runtime', childPid: 99, clock, logger: log.logger });
    let admitted = 0;
    for (let index = 0; index < 10_000; index += 1) if (limiter.admit(10)) admitted += 1;
    expect(admitted).toBe(200);
    clock.advance(1000);
    expect(limiter.admit(10)).toBe(true);
    const summaries = log.events('child.output.dropped');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ child: 'runtime', childPid: 99, dropped: 9800, droppedBytes: 98_000 });
  });

  it('bounds the bytes per minute', () => {
    const clock = createFakeClock(T0);
    const log = createLogBuffer(clock);
    const limiter = createOutputLimiter({ role: 'gateway', childPid: 5, clock, logger: log.logger });
    let admittedBytes = 0;
    for (let second = 0; second < 60; second += 1) {
      for (let index = 0; index < 52; index += 1) if (limiter.admit(1024)) admittedBytes += 1024;
      clock.advance(1000);
    }
    expect(admittedBytes).toBe(1_048_576);
    expect(limiter.admit(1024)).toBe(true);
    const summaries = log.events('child.output.dropped');
    const dropped = summaries.reduce((sum, line) => sum + (line['dropped'] as number), 0);
    const droppedBytes = summaries.reduce((sum, line) => sum + (line['droppedBytes'] as number), 0);
    expect(dropped).toBe(60 * 52 - 1024);
    expect(droppedBytes).toBe((60 * 52 - 1024) * 1024);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
  });

  it('a flooding child is limited and the lifecycle records survive', async () => {
    const clock = createFakeClock(T0);
    const log = createLogBuffer(clock);
    const limiter = createOutputLimiter({ role: 'runtime', childPid: 31, clock, logger: log.logger });
    const stream = new PassThrough();
    const done = captureStream({ stream, kind: 'stderr', role: 'runtime', childPid: 31, service: 'supervisor', logger: log.logger, limiter });
    for (let index = 0; index < 10_000; index += 1) stream.write(`flood line ${index}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.advance(1000);
    stream.write('after the window\n');
    stream.end();
    await done;
    expect(stream.readableEnded).toBe(true);
    const records = log.events('child.stderr');
    expect(records.length).toBeLessThanOrEqual(201);
    expect(records.length).toBeGreaterThanOrEqual(200);
    expect(records.at(-1)?.['raw']).toBe('after the window');
    const summaries = log.events('child.output.dropped');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.['dropped']).toBe(9800);
    log.logger.warn('child.exit', { data: { child: 'runtime', childPid: 31, code: 1 } });
    expect(log.events('child.exit')).toHaveLength(1);
  });
  it('drops of the last window are reported when the stream ends', async () => {
    const clock = createFakeClock(T0);
    const log = createLogBuffer(clock);
    const limiter = createOutputLimiter({ role: 'runtime', childPid: 32, clock, logger: log.logger });
    const stream = new PassThrough();
    const done = captureStream({ stream, kind: 'stderr', role: 'runtime', childPid: 32, service: 'supervisor', logger: log.logger, limiter });
    for (let index = 0; index < 1000; index += 1) stream.write(`flood line ${index}\n`);
    stream.end();
    await done;
    expect(log.events('child.stderr')).toHaveLength(200);
    const summaries = log.events('child.output.dropped');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ child: 'runtime', childPid: 32, dropped: 800 });
    limiter.flush();
    expect(log.events('child.output.dropped')).toHaveLength(1);
  });

  it('captureStream flushes its limiter exactly once at stream end', async () => {
    const clock = createFakeClock(T0);
    const log = createLogBuffer(clock);
    let flushes = 0;
    let flushedAfterLastLine = false;
    let admitted = 0;
    const limiter: OutputLimiter = {
      admit: () => {
        admitted += 1;
        flushedAfterLastLine = false;
        return true;
      },
      flush: () => {
        flushes += 1;
        flushedAfterLastLine = true;
      },
    };
    const stream = new PassThrough();
    const done = captureStream({ stream, kind: 'stdout', role: 'gateway', childPid: 8, service: 'supervisor', logger: log.logger, limiter });
    stream.write('one\ntrailing without newline');
    stream.end();
    await done;
    expect(admitted).toBe(2);
    expect(flushes).toBe(1);
    expect(flushedAfterLastLine).toBe(true);
  });

  it('captureStream of an already destroyed stream flushes exactly once', async () => {
    const clock = createFakeClock(T0);
    const log = createLogBuffer(clock);
    let flushes = 0;
    const limiter: OutputLimiter = {
      admit: () => true,
      flush: () => {
        flushes += 1;
      },
    };
    const stream = new PassThrough();
    stream.destroy();
    await captureStream({ stream, kind: 'stderr', role: 'runtime', childPid: 9, service: 'supervisor', logger: log.logger, limiter });
    for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(flushes).toBe(1);
  });

  it('the byte limit counts the serialized wrapped record', async () => {
    const clock = createFakeClock(T0);
    const chunks: string[] = [];
    const logger = createJsonLogger({
      service: 'supervisor',
      clock,
      stream: {
        write: (chunk: string) => {
          chunks.push(chunk);
          return true;
        },
      },
    });
    const limiter = createOutputLimiter({ role: 'runtime', childPid: 33, clock, logger });
    const stream = new PassThrough();
    const done = captureStream({ stream, kind: 'stdout', role: 'runtime', childPid: 33, service: 'supervisor', logger, limiter });
    const raw = 'x'.repeat(100);
    const linesPerSecond = 150;
    const seconds = 59;
    for (let second = 0; second < seconds; second += 1) {
      for (let index = 0; index < linesPerSecond; index += 1) stream.write(`${raw}\n`);
      for (let turn = 0; turn < 3; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      clock.advance(1000);
    }
    stream.end();
    await done;
    const records = chunks.filter((chunk) => chunk.includes('"msg":"child.stdout"'));
    const recordBytes = Buffer.byteLength(records[0] ?? '');
    expect(recordBytes).toBeGreaterThan(100);
    const written = records.length;
    expect([Math.floor(OUTPUT_MAX_BYTES_PER_MINUTE / recordBytes), Math.floor(OUTPUT_MAX_BYTES_PER_MINUTE / (recordBytes - 1))]).toContain(written);
    const summaries = chunks.filter((chunk) => chunk.includes('"msg":"child.output.dropped"')).map((chunk) => JSON.parse(chunk) as Record<string, number>);
    const dropped = summaries.reduce((sum, line) => sum + (line['dropped'] ?? 0), 0);
    const droppedBytes = summaries.reduce((sum, line) => sum + (line['droppedBytes'] ?? 0), 0);
    expect(dropped).toBe(linesPerSecond * seconds - written);
    expect([dropped * recordBytes, dropped * (recordBytes - 1)]).toContain(droppedBytes);
  });

  it('the limiter counts the bytes of the line the injected logger actually writes', async () => {
    const clock = createFakeClock(T0);
    const service = 'momonga-injected-service';
    const chunks: string[] = [];
    const logger = createJsonLogger({
      service,
      clock,
      stream: {
        write: (chunk: string) => {
          chunks.push(chunk);
          return true;
        },
      },
    });
    const admitted: number[] = [];
    const limiter: OutputLimiter = {
      admit: (bytes) => {
        admitted.push(bytes);
        return true;
      },
      flush: () => undefined,
    };
    const stream = new PassThrough();
    const done = captureStream({ stream, kind: 'stdout', role: 'gateway', childPid: 44, service, logger, limiter });
    stream.end('hello\n');
    await done;
    const written = chunks.filter((chunk) => chunk.includes('"msg":"child.stdout"'));
    expect(written).toHaveLength(1);
    expect(admitted).toEqual([Buffer.byteLength(written[0] ?? '')]);
    expect(
      formatLogLine({ ts: new Date(T0).toISOString(), level: 'info', service, msg: 'child.stdout', fields: { data: { child: 'gateway', childPid: 44, raw: 'hello', rawBytes: 5 } } }),
    ).toBe(written[0]);
  });

  it('flush without drops writes nothing', () => {
    const clock = createFakeClock(T0);
    const log = createLogBuffer(clock);
    const limiter = createOutputLimiter({ role: 'gateway', childPid: 6, clock, logger: log.logger });
    expect(limiter.admit(10)).toBe(true);
    limiter.flush();
    expect(log.events('child.output.dropped')).toHaveLength(0);
  });
});
