import type { Readable } from 'node:stream';
import { formatLogLine } from '@momonga/foundation';
import type { Clock, JsonLogger } from '@momonga/foundation';
import { OUTPUT_MAX_BYTES_PER_MINUTE, OUTPUT_MAX_LINES_PER_SECOND, RAW_MAX_BYTES } from './constants.ts';
import { createLineSplitter } from './line-splitter.ts';
import { childOutputDropped, childStderr, childStdout, writeEvent } from './log-events.ts';
import type { SupervisorLogEvent } from './log-events.ts';
import type { ChildRole } from './launcher.ts';

export type CaptureKind = 'stdout' | 'stderr';

export type RawPart = { raw: string; rawBytes: number; truncated?: true };

export type OutputLimiter = {
  admit(bytes: number): boolean;
  flush(): void;
};

export type OutputLimiterOptions = {
  role: ChildRole;
  childPid: number;
  clock: Clock;
  logger: JsonLogger;
  maxLinesPerSecond?: number;
  maxBytesPerMinute?: number;
};

export type CaptureOptions = {
  stream: Readable;
  kind: CaptureKind;
  role: ChildRole;
  childPid: number;
  logger: JsonLogger;
  service: string;
  limiter: OutputLimiter;
  consume?(line: string): boolean;
};

export const DEFAULT_OUTPUT_LIMITS = { maxLinesPerSecond: OUTPUT_MAX_LINES_PER_SECOND, maxBytesPerMinute: OUTPUT_MAX_BYTES_PER_MINUTE } as const;

const CONTINUATION_MASK = 0xc0;
const CONTINUATION_BITS = 0x80;
const LINE_WINDOW_MS = 1000;
const BYTE_WINDOW_MS = 60_000;

export const truncateRaw = (line: string, maxBytes: number = RAW_MAX_BYTES): RawPart => {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= maxBytes) return { raw: line, rawBytes: bytes.length };
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & CONTINUATION_MASK) === CONTINUATION_BITS) end -= 1;
  return { raw: bytes.toString('utf8', 0, end), rawBytes: bytes.length, truncated: true };
};

export const createOutputLimiter = (options: OutputLimiterOptions): OutputLimiter => {
  const maxLinesPerSecond = options.maxLinesPerSecond ?? DEFAULT_OUTPUT_LIMITS.maxLinesPerSecond;
  const maxBytesPerMinute = options.maxBytesPerMinute ?? DEFAULT_OUTPUT_LIMITS.maxBytesPerMinute;
  let lineWindowStart: number | undefined;
  let byteWindowStart: number | undefined;
  let linesInWindow = 0;
  let bytesInWindow = 0;
  let dropped = 0;
  let droppedBytes = 0;

  const reportDrops = (): void => {
    if (dropped === 0) return;
    const summary = { child: options.role, childPid: options.childPid, dropped, droppedBytes };
    dropped = 0;
    droppedBytes = 0;
    writeEvent(options.logger, childOutputDropped(summary));
  };

  const rollWindows = (now: number): void => {
    let rolled = false;
    if (lineWindowStart === undefined || now - lineWindowStart >= LINE_WINDOW_MS) {
      rolled = lineWindowStart !== undefined;
      lineWindowStart = now;
      linesInWindow = 0;
    }
    if (byteWindowStart === undefined || now - byteWindowStart >= BYTE_WINDOW_MS) {
      rolled = rolled || byteWindowStart !== undefined;
      byteWindowStart = now;
      bytesInWindow = 0;
    }
    if (rolled) reportDrops();
  };

  return {
    admit: (bytes) => {
      rollWindows(options.clock.now());
      if (linesInWindow >= maxLinesPerSecond || bytesInWindow + bytes > maxBytesPerMinute) {
        dropped += 1;
        droppedBytes += bytes;
        return false;
      }
      linesInWindow += 1;
      bytesInWindow += bytes;
      return true;
    },
    flush: reportDrops,
  };
};

const RECORD_TIMESTAMP_PLACEHOLDER = new Date(0).toISOString();

export const serializedRecordBytes = (event: SupervisorLogEvent, service: string): number =>
  Buffer.byteLength(
    formatLogLine({
      ts: RECORD_TIMESTAMP_PLACEHOLDER,
      level: event.level,
      service,
      msg: event.msg,
      fields: { data: event.data, ...(event.err === undefined ? {} : { err: event.err }) },
    }),
  );

const toBuffer = (chunk: Buffer | string): Buffer => (typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);

export const captureStream = (options: CaptureOptions): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const buildEvent = options.kind === 'stderr' ? childStderr : childStdout;
    const splitter = createLineSplitter((line) => {
      if (options.consume?.(line) === true) return;
      const event = buildEvent({ child: options.role, childPid: options.childPid, ...truncateRaw(line) });
      if (!options.limiter.admit(serializedRecordBytes(event, options.service))) return;
      writeEvent(options.logger, event);
    });
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      try {
        splitter.end();
        options.limiter.flush();
      } catch (error) {
        reject(error);
        return;
      }
      resolve();
    };
    options.stream.on('data', (chunk: Buffer | string) => {
      try {
        splitter.push(toBuffer(chunk));
      } catch (error) {
        options.stream.destroy();
        reject(error);
      }
    });
    options.stream.once('close', finish);
    if (options.stream.closed) finish();
  });
