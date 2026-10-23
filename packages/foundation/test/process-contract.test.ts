import { describe, expect, it } from 'vitest';
import {
  EXIT_ALREADY_RUNNING,
  EXIT_CONFIG,
  EXIT_FAILURE,
  EXIT_OK,
  MINIMAL_CHILD_ENV_LC_PREFIX,
  MINIMAL_CHILD_ENV_NAMES,
  announceReady,
  createJsonLogger,
  isLoopbackHost,
} from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';

const START_MS = 1_800_000_000_000;
const START_ISO = new Date(START_MS).toISOString();

const captureStream = () => {
  const chunks: string[] = [];
  return {
    chunks,
    stream: { write: (chunk: string): boolean => (chunks.push(chunk), true) },
    lines: (): unknown[] => chunks.join('').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as unknown),
  };
};

describe('exit codes', () => {
  it('pins the documented values', () => {
    expect([EXIT_OK, EXIT_FAILURE, EXIT_CONFIG]).toEqual([0, 1, 78]);
  });

  it('EXIT_ALREADY_RUNNING is 75', () => {
    expect(EXIT_ALREADY_RUNNING).toBe(75);
  });
});

describe('minimal child env', () => {
  it('names exactly PATH, HOME, LANG and TMPDIR plus the LC_ prefix', () => {
    expect([...MINIMAL_CHILD_ENV_NAMES]).toEqual(['PATH', 'HOME', 'LANG', 'TMPDIR']);
    expect(MINIMAL_CHILD_ENV_LC_PREFIX).toBe('LC_');
  });
});

describe('isLoopbackHost', () => {
  it.each(['localhost', '127.0.0.1', '127.255.255.254', '127.1.2.3', '::1', '[::1]'])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['example.com', '128.0.0.1', '126.255.255.255', '10.0.0.1', '0.0.0.0', '::', '[::]', '127.0.0.1.evil.com', 'localhost.evil.com', '', '::2'])(
    'rejects %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe('announceReady', () => {
  it('writes exactly one ready line with the fields in order', () => {
    const capture = captureStream();
    announceReady(
      { service: 'gateway', pid: 4242, version: '1.2.3', socketPath: '/h/.momonga/run/gateway.sock', startedAt: START_ISO },
      capture.stream,
    );
    expect(capture.chunks.join('')).toBe(
      `{"event":"ready","service":"gateway","pid":4242,"version":"1.2.3","socketPath":"/h/.momonga/run/gateway.sock","startedAt":"${START_ISO}"}\n`,
    );
  });
});

describe('createJsonLogger', () => {
  it('writes one JSON line per entry with ts, level, service, pid and msg', () => {
    const capture = captureStream();
    const logger = createJsonLogger({ service: 'gateway', stream: capture.stream, clock: createFakeClock(START_MS) });
    logger.info('started');
    expect(capture.chunks).toHaveLength(1);
    expect(capture.chunks[0]?.endsWith('\n')).toBe(true);
    expect(capture.lines()).toEqual([{ ts: START_ISO, level: 'info', service: 'gateway', pid: process.pid, msg: 'started' }]);
  });

  it('includes runId, workerId and traceId when given and omits them otherwise', () => {
    const capture = captureStream();
    const logger = createJsonLogger({ service: 'runtime', stream: capture.stream, clock: createFakeClock(START_MS) });
    logger.warn('slow step', { runId: 'run-1', workerId: 'w-2', traceId: '0af7651916cd43dd8448eb211c80319c' });
    logger.warn('plain');
    expect(capture.lines()).toEqual([
      {
        ts: START_ISO,
        level: 'warn',
        service: 'runtime',
        pid: process.pid,
        msg: 'slow step',
        runId: 'run-1',
        workerId: 'w-2',
        traceId: '0af7651916cd43dd8448eb211c80319c',
      },
      { ts: START_ISO, level: 'warn', service: 'runtime', pid: process.pid, msg: 'plain' },
    ]);
  });

  it('writes the step field', () => {
    const capture = captureStream();
    const logger = createJsonLogger({ service: 'runtime', stream: capture.stream, clock: createFakeClock(START_MS), level: 'debug' });
    logger.debug('startup.step', { step: 'open-store' });
    logger.debug('plain');
    expect(capture.lines()).toEqual([
      { ts: START_ISO, level: 'debug', service: 'runtime', pid: process.pid, msg: 'startup.step', step: 'open-store' },
      { ts: START_ISO, level: 'debug', service: 'runtime', pid: process.pid, msg: 'plain' },
    ]);
  });

  it('serialises err as exactly name, message and stack', () => {
    const capture = captureStream();
    const logger = createJsonLogger({ service: 'gateway', stream: capture.stream, clock: createFakeClock(START_MS) });
    const error = Object.assign(new TypeError('bad input'), { secretField: 'SENTINEL-err-field' });
    logger.error('failed', { err: error });
    expect(capture.lines()).toEqual([
      {
        ts: START_ISO,
        level: 'error',
        service: 'gateway',
        pid: process.pid,
        msg: 'failed',
        err: { name: 'TypeError', message: 'bad input', stack: error.stack },
      },
    ]);
    expect(capture.chunks.join('')).not.toContain('SENTINEL-err-field');
  });

  it('drops fields outside the contract such as env or bodies', () => {
    const capture = captureStream();
    const logger = createJsonLogger({ service: 'gateway', stream: capture.stream, clock: createFakeClock(START_MS) });
    logger.info('request', { runId: 'run-1', env: { OPENAI_API_KEY: 'SENTINEL-env' }, body: 'SENTINEL-body' } as never);
    expect(capture.lines()).toEqual([{ ts: START_ISO, level: 'info', service: 'gateway', pid: process.pid, msg: 'request', runId: 'run-1' }]);
  });

  it('uses the clock for each entry', () => {
    const capture = captureStream();
    const clock = createFakeClock(START_MS);
    const logger = createJsonLogger({ service: 'gateway', stream: capture.stream, clock });
    logger.info('a');
    clock.advance(1500);
    logger.info('b');
    expect(capture.lines().map((line) => (line as { ts: string }).ts)).toEqual([START_ISO, new Date(START_MS + 1500).toISOString()]);
  });

  it('filters entries below the configured level', () => {
    const capture = captureStream();
    const logger = createJsonLogger({ service: 'gateway', stream: capture.stream, clock: createFakeClock(START_MS), level: 'warn' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(capture.lines().map((line) => [(line as { level: string }).level, (line as { msg: string }).msg])).toEqual([
      ['warn', 'w'],
      ['error', 'e'],
    ]);
  });

  it('emits debug entries when the level is debug', () => {
    const capture = captureStream();
    const logger = createJsonLogger({ service: 'gateway', stream: capture.stream, clock: createFakeClock(START_MS), level: 'debug' });
    logger.debug('d');
    expect(capture.lines()).toEqual([{ ts: START_ISO, level: 'debug', service: 'gateway', pid: process.pid, msg: 'd' }]);
  });
});
