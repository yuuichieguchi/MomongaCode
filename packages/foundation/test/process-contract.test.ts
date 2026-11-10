import { describe, expect, it } from 'vitest';
import {
  EXIT_ALREADY_RUNNING,
  EXIT_CONFIG,
  EXIT_FAILURE,
  EXIT_OK,
  DAEMON_MARKER_FD,
  ENTRY_HARD_EXIT_MARGIN_MS,
  DEFAULT_STOP_VALUES,
  LIFELINE_FD,
  MINIMAL_CHILD_ENV_LC_PREFIX,
  MINIMAL_CHILD_ENV_NAMES,
  MINIMAL_CHILD_PATH,
  RUNTIME_ABORT_BUDGET_MS,
  RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS,
  RUNTIME_TEARDOWN_BUDGET_MS,
  SHUTDOWN_MARGIN_MS,
  STDIO_EXIT_FLUSH_MS,
  CHILD_STDIO_FLUSH_MS,
  KILL_CONFIRM_MS,
  SHUTDOWN_DRAIN_BOUND_MS,
  SHUTDOWN_REAP_BOUND_MS,
  SHUTDOWN_RELEASE_BOUND_MS,
  managedServerStopBoundMs,
  gatewayMaxCloseMs,
  gatewayStopBudgetMs,
  managedServerReapBoundMs,
  killedChildSettleMs,
  runtimeStopBudgetMs,
  announceReady,
  createJsonLogger,
  formatLogLine,
  isLoopbackHost,
  minimalChildEnv,
  parseReadyLine,
  runtimeMaxCloseMs,
  supervisorMaxCloseMs,
} from '@momonga/foundation';
import type { LogFields, ReadyFields } from '@momonga/foundation';
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

  it('emits count and ids when given and omits them otherwise', () => {
    const capture = captureStream();
    const logger = createJsonLogger({ service: 'runtime', stream: capture.stream, clock: createFakeClock(START_MS), level: 'debug' });
    logger.debug('session_state.evicted', { count: 2, ids: ['ses-a', 'ses-b'] });
    logger.debug('session_state.evicted', { count: 0, ids: [] });
    logger.debug('plain');
    expect(capture.lines()).toEqual([
      { ts: START_ISO, level: 'debug', service: 'runtime', pid: process.pid, msg: 'session_state.evicted', count: 2, ids: ['ses-a', 'ses-b'] },
      { ts: START_ISO, level: 'debug', service: 'runtime', pid: process.pid, msg: 'session_state.evicted', count: 0, ids: [] },
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

describe('formatLogLine', () => {
  it('renders the exact line with data first, then the envelope, then the reserved fields', () => {
    const line = formatLogLine({
      ts: START_ISO,
      level: 'warn',
      service: 'custom-service',
      msg: 'thing.happened',
      fields: { runId: 'run-9', data: { detail: 'x', service: 'shadowed' } },
    });
    expect(line).toBe(`{"detail":"x","ts":"${START_ISO}","level":"warn","service":"custom-service","pid":${process.pid},"msg":"thing.happened","runId":"run-9"}\n`);
  });

  it('is byte-identical to what createJsonLogger writes for the same service and entry', () => {
    const capture = captureStream();
    const logger = createJsonLogger({ service: 'custom-service', stream: capture.stream, clock: createFakeClock(START_MS) });
    logger.error('boom', { count: 3, data: { child: 'runtime' } });
    expect(capture.chunks).toEqual([formatLogLine({ ts: START_ISO, level: 'error', service: 'custom-service', msg: 'boom', fields: { count: 3, data: { child: 'runtime' } } })]);
  });
});

describe('close budgets', () => {
  it('pins the runtime budgets and the default drain', () => {
    expect([RUNTIME_ABORT_BUDGET_MS, RUNTIME_TEARDOWN_BUDGET_MS, RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS]).toEqual([5000, 10_000, 30_000]);
  });

  it('runtimeMaxCloseMs equals drain + 15000', () => {
    expect(runtimeMaxCloseMs(0)).toBe(15_000);
    expect(runtimeMaxCloseMs(30_000)).toBe(45_000);
    expect(runtimeMaxCloseMs(1)).toBe(15_001);
  });

  it('pins the gateway close at the default stop values, the margins and the stdio flushes', () => {
    expect(gatewayMaxCloseMs(DEFAULT_STOP_VALUES)).toBe(DEFAULT_STOP_VALUES.closeGraceMs + managedServerStopBoundMs(DEFAULT_STOP_VALUES.managedServerStopGraceMs));
    expect([DEFAULT_STOP_VALUES.closeGraceMs, DEFAULT_STOP_VALUES.managedServerStopGraceMs, managedServerStopBoundMs(DEFAULT_STOP_VALUES.managedServerStopGraceMs), gatewayMaxCloseMs(DEFAULT_STOP_VALUES)]).toEqual([10_000, 3000, 18_000, 28_000]);
    expect(ENTRY_HARD_EXIT_MARGIN_MS).toBe(3000);
    expect(SHUTDOWN_MARGIN_MS).toBe(5000);
    expect(STDIO_EXIT_FLUSH_MS).toBe(1000);
    expect(CHILD_STDIO_FLUSH_MS).toBe(1000);
  });

  it('pins the supervisor shutdown bounds', () => {
    expect([KILL_CONFIRM_MS, SHUTDOWN_DRAIN_BOUND_MS, SHUTDOWN_REAP_BOUND_MS, SHUTDOWN_RELEASE_BOUND_MS]).toEqual([5000, 2000, 4000, 5000]);
  });

  it('ENTRY_HARD_EXIT_MARGIN_MS + STDIO_EXIT_FLUSH_MS < SHUTDOWN_MARGIN_MS', () => {
    expect(ENTRY_HARD_EXIT_MARGIN_MS + STDIO_EXIT_FLUSH_MS).toBeLessThan(SHUTDOWN_MARGIN_MS);
  });

  it('a child that had to be group-killed settles within the kill confirmation plus one stdio flush', () => {
    expect(killedChildSettleMs()).toBe(KILL_CONFIRM_MS + CHILD_STDIO_FLUSH_MS);
  });

  it('the stop budgets are the child close budgets plus the shutdown margin', () => {
    expect(runtimeStopBudgetMs(30_000)).toBe(runtimeMaxCloseMs(30_000) + SHUTDOWN_MARGIN_MS);
    expect(gatewayStopBudgetMs(DEFAULT_STOP_VALUES)).toBe(gatewayMaxCloseMs(DEFAULT_STOP_VALUES) + SHUTDOWN_MARGIN_MS);
  });

  it('supervisorMaxCloseMs counts every wait of the orderly shutdown once', () => {
    expect(supervisorMaxCloseMs(30_000, DEFAULT_STOP_VALUES)).toBe(118_100);
    expect(supervisorMaxCloseMs(0, DEFAULT_STOP_VALUES)).toBe(88_100);
    for (const drain of [1, 1000, 12_345]) {
      const steps = [
        SHUTDOWN_DRAIN_BOUND_MS,
        runtimeStopBudgetMs(drain),
        KILL_CONFIRM_MS + CHILD_STDIO_FLUSH_MS,
        gatewayStopBudgetMs(DEFAULT_STOP_VALUES),
        KILL_CONFIRM_MS + CHILD_STDIO_FLUSH_MS,
        managedServerReapBoundMs(DEFAULT_STOP_VALUES),
        SHUTDOWN_REAP_BOUND_MS,
        SHUTDOWN_RELEASE_BOUND_MS,
      ];
      expect(supervisorMaxCloseMs(drain, DEFAULT_STOP_VALUES), String(drain)).toBe(steps.reduce((sum, step) => sum + step, 0));
    }
  });
});

describe('fd numbers', () => {
  it('LIFELINE_FD is 3 and DAEMON_MARKER_FD is 4', () => {
    expect(LIFELINE_FD).toBe(3);
    expect(DAEMON_MARKER_FD).toBe(4);
  });
});

describe('minimalChildEnv', () => {
  it('pins MINIMAL_CHILD_PATH', () => {
    expect(MINIMAL_CHILD_PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('forces PATH, copies HOME, LANG, TMPDIR and LC_*, and drops everything else', () => {
    const env = minimalChildEnv({
      PATH: '/opt/evil/bin:/usr/bin',
      HOME: '/Users/alice',
      LANG: 'ja_JP.UTF-8',
      TMPDIR: '/var/folders/t/',
      LC_ALL: 'C',
      LC_CTYPE: 'UTF-8',
      AWS_SECRET_ACCESS_KEY: 'SENTINEL-aws',
      FOO: 'bar',
      UNSET: undefined,
    });
    expect(env).toEqual({
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/Users/alice',
      LANG: 'ja_JP.UTF-8',
      TMPDIR: '/var/folders/t/',
      LC_ALL: 'C',
      LC_CTYPE: 'UTF-8',
    });
  });

  it('sets PATH even when the source has none and omits absent names', () => {
    expect(minimalChildEnv({})).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  });
});

describe('parseReadyLine', () => {
  const fieldSets: ReadyFields[] = [
    { service: 'runtime', pid: 4242, version: '1.2.3', socketPath: '/h/.momonga/run/runtime.sock', startedAt: START_ISO },
    { service: 'gateway', pid: 1, version: '0.0.0-dev+abc', socketPath: '/tmp/x y/gateway.sock', startedAt: '2026-01-01T00:00:00.000Z' },
    { service: 'supervisor', pid: 99_999, version: '', socketPath: '/s/\u00e9.sock', startedAt: START_ISO },
  ];

  it.each(fieldSets)('parseReadyLine round-trips announceReady for $service', (fields) => {
    const capture = captureStream();
    announceReady(fields, capture.stream);
    expect(parseReadyLine(capture.chunks.join(''))).toEqual(fields);
    expect(parseReadyLine(capture.chunks.join('').trimEnd())).toEqual(fields);
  });

  it.each([
    ['non-JSON', 'ready'],
    ['a JSON array', '["ready"]'],
    ['missing event', '{"service":"runtime","pid":1,"version":"1","socketPath":"/s","startedAt":"t"}'],
    ['event log', '{"event":"log","service":"runtime","pid":1,"version":"1","socketPath":"/s","startedAt":"t"}'],
    ['string pid', '{"event":"ready","service":"runtime","pid":"1","version":"1","socketPath":"/s","startedAt":"t"}'],
    ['fractional pid', '{"event":"ready","service":"runtime","pid":1.5,"version":"1","socketPath":"/s","startedAt":"t"}'],
    ['missing socketPath', '{"event":"ready","service":"runtime","pid":1,"version":"1","startedAt":"t"}'],
    ['extra garbage after the object', '{"event":"ready","service":"runtime","pid":1,"version":"1","socketPath":"/s","startedAt":"t"} trailing'],
    ['JSON null', 'null'],
    ['empty line', ''],
  ])('parseReadyLine rejects %s', (_name, line) => {
    expect(() => parseReadyLine(line)).not.toThrow();
    expect(parseReadyLine(line)).toBeUndefined();
  });
});

describe('LogFields.data', () => {
  it('LogFields.data is serialised and cannot override core keys', () => {
    const capture = captureStream();
    const logger = createJsonLogger({ service: 'runtime', stream: capture.stream, clock: createFakeClock(START_MS) });
    logger.info('entry.exit', { runId: 'r', data: { path: 'close', ts: 'x', runId: 'y', level: 'error', msg: 'forged', code: 0, clean: true, trigger: null } });
    expect(capture.lines()).toEqual([
      { ts: START_ISO, level: 'info', service: 'runtime', pid: process.pid, msg: 'entry.exit', runId: 'r', path: 'close', code: 0, clean: true, trigger: null },
    ]);
  });

  it('a data key that names an absent LogFields key is not written', () => {
    const capture = captureStream();
    const logger = createJsonLogger({ service: 'runtime', stream: capture.stream, clock: createFakeClock(START_MS) });
    logger.info('entry.start', { data: { logTarget: 'file', pid: 7, service: 'gateway', err: 'forged' } });
    expect(capture.lines()).toEqual([{ ts: START_ISO, level: 'info', service: 'runtime', pid: process.pid, msg: 'entry.start', logTarget: 'file' }]);
  });
});

describe('O-R5-6 (M) 6.3: a list value of a structured event is a bounded JSON array', () => {
  const lineWith = (data: Record<string, unknown>): Record<string, unknown> => {
    const capture = captureStream();
    const logger = createJsonLogger({ service: 'gateway', stream: capture.stream, clock: createFakeClock(START_MS) });
    logger.info('plan.catalog', { data } as unknown as LogFields);
    const [line] = capture.lines();
    return line as Record<string, unknown>;
  };

  it('a list value is written as a JSON array', () => {
    const line = lineWith({ entryKeys: ['context_window', 'slug'] });
    expect(line['entryKeys']).toEqual(['context_window', 'slug']);
    expect(line).not.toHaveProperty('entryKeysOmitted');
  });

  it('a list of more than 64 items is cut to 64 and the line carries <key>Omitted with the number left out', () => {
    const items = Array.from({ length: 70 }, (_, index) => `key-${index}`);
    const line = lineWith({ entryKeys: items });
    expect(line['entryKeys']).toEqual(items.slice(0, 64));
    expect(line['entryKeysOmitted']).toBe(6);
  });

  it('an item of more than 64 characters is cut to 64', () => {
    const line = lineWith({ claimNames: ['a'.repeat(65), 'b'.repeat(64), 'short'] });
    expect(line['claimNames']).toEqual(['a'.repeat(64), 'b'.repeat(64), 'short']);
    expect(line).not.toHaveProperty('claimNamesOmitted');
  });
});
