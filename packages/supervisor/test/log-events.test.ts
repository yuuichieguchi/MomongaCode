import { describe, expect, expectTypeOf, it } from 'vitest';
import { createJsonLogger } from '@momonga/foundation';
import type { LogLevel } from '@momonga/foundation';
import type { JsonLine } from '@momonga/testkit';
import {
  SUPERVISOR_EVENTS,
  childReadyIgnored,
  childStdout,
  defineEvent,
  orphansReaped,
  supervisorBackgroundFailed,
  writeEvent,
} from '../src/log-events.ts';
import type { EventPayload, ReservedLogKey } from '../src/log-events.ts';
import type { StopReason } from '../src/restart-policy.ts';

type Events = typeof SUPERVISOR_EVENTS;
type DefinableWith<P> = P extends EventPayload ? true : false;
type PayloadOf<K extends keyof Events> = Parameters<Events[K]>[0];

const SAMPLES: { [K in keyof Events]: PayloadOf<K> } = {
  'phase.change': { from: 'reaping-orphans', to: 'running' },
  'child.spawn': { child: 'runtime', childPid: 4242, restarts: 2, reason: 'backoff' },
  'child.ready': { child: 'gateway', childPid: 4243, version: '1.2.3', socketPath: '/h/.momonga/run/gateway.sock', startedAt: '2026-01-01T00:00:00.000Z' },
  'child.ready.mismatch': { child: 'runtime', childPid: 4244, readyService: 'gateway', readyPid: 1 },
  'child.ready.ignored': { child: 'runtime', childPid: 4245 },
  'child.version.mismatch': { child: 'runtime', childPid: 4248, childVersion: '9.9.9', supervisorVersion: '1.2.3' },
  'child.stop': { child: 'runtime', childPid: 4246, stop: 'shutdown', mode: 'term', superseded: 'startup-timeout' },
  'child.exit': { child: 'gateway', childPid: 4247, code: 1, signal: null, reason: 'failure', restarts: 3 },
  'child.backoff': { child: 'runtime', delayMs: 999, consecutiveFailures: 2 },
  'child.held': { child: 'gateway', heldReason: 'child exited 78 (see gateway.log)', source: 'child-exit' },
  'child.external': { child: 'runtime', holderPid: 777 },
  'child.unkillable': { child: 'runtime', childPid: 4248 },
  'child.error': { child: 'gateway', childPid: null },
  'child.output.dropped': { child: 'runtime', childPid: 4249, dropped: 10, droppedBytes: 2048 },
  'child.stderr': { child: 'runtime', childPid: 4250, raw: 'Error: boom', rawBytes: 11 },
  'child.stdout': { child: 'gateway', childPid: 4251, raw: 'stray', rawBytes: 5, truncated: true },
  'supervisor.background_transient': { source: 'lock-poll' },
  'supervisor.background_failed': { source: 'exit-handler' },
  'settings.changed': {},
  'settings.invalid': { detail: 'settings file is invalid: bad', action: 'keep-running-children-hold-spawns' },
  'settings.read_failed': { detail: 'EMFILE' },
  'settings.warning': { detail: 'settings file is invalid: x' },
  'settings.record_failed': { detail: 'EACCES: permission denied' },
  'orphans.waiting': { markers: 2, holders: 1 },
  'orphans.reaping': { holders: 1 },
  'orphans.reaped': { reaped: 1, kept: 0 },
  'orphans.warning': { detail: 'lsof failed', marker: '/h/.momonga/run/markers/daemons/runtime-x' },
  'start.abandoned': { generation: 2, reason: 'version-differs' },
  'start.superseded': { generation: 2, current: 3 },
  'start.unpromoted': { generation: 2, reason: 'startup-bound' },
  'generation.promoted': { generation: 2, version: '1.2.3', startToPromotedMs: 120 },
  'generation.retiring': { generation: 2, current: 3 },
  'generation.ended': { generation: 2, liveMs: 4000 },
  'generation.successor': { generation: 2, successor: 3, version: '1.2.4', outcome: 'started' },
  'generation.many': { live: 4 },
  'generation.reaped': { removed: ['1'], kept: [], busy: false },
  'shutdown.begin': { mode: 'close' },
  'shutdown.step': { shutdownStep: 4, detail: 'step 4 bound reached' },
  'shutdown.end': { clean: true, killed: '', leaked: '' },
};

const EXPECTED_LEVELS: { [K in keyof Events]: LogLevel } = {
  'phase.change': 'info',
  'child.spawn': 'info',
  'child.ready': 'info',
  'child.ready.mismatch': 'error',
  'child.ready.ignored': 'info',
  'child.version.mismatch': 'error',
  'child.stop': 'info',
  'child.exit': 'info',
  'child.backoff': 'info',
  'child.held': 'warn',
  'child.external': 'warn',
  'child.unkillable': 'error',
  'child.error': 'warn',
  'child.output.dropped': 'warn',
  'child.stderr': 'warn',
  'child.stdout': 'info',
  'supervisor.background_failed': 'error',
  'supervisor.background_transient': 'warn',
  'settings.changed': 'info',
  'settings.invalid': 'warn',
  'settings.read_failed': 'warn',
  'settings.warning': 'warn',
  'settings.record_failed': 'warn',
  'orphans.waiting': 'info',
  'orphans.reaping': 'warn',
  'orphans.reaped': 'info',
  'orphans.warning': 'warn',
  'start.abandoned': 'warn',
  'start.superseded': 'info',
  'start.unpromoted': 'warn',
  'generation.promoted': 'info',
  'generation.retiring': 'info',
  'generation.ended': 'info',
  'generation.successor': 'info',
  'generation.many': 'warn',
  'generation.reaped': 'info',
  'shutdown.begin': 'info',
  'shutdown.step': 'info',
  'shutdown.end': 'info',
};

const RESERVED: readonly ReservedLogKey[] = ['ts', 'level', 'service', 'pid', 'msg', 'runId', 'workerId', 'traceId', 'step', 'count', 'ids', 'err'];

const loggerInto = (level: LogLevel = 'info') => {
  const lines: string[] = [];
  const logger = createJsonLogger({
    service: 'supervisor',
    clock: { now: () => Date.parse('2026-01-01T00:00:00.000Z') },
    stream: { write: (chunk) => (lines.push(...chunk.split('\n').filter((line) => line !== '')), true) },
    level,
  });
  return { logger, parsed: (): JsonLine[] => lines.map((line) => JSON.parse(line) as JsonLine) };
};

const emit = <K extends keyof Events>(name: K, err?: Error): JsonLine => {
  const { logger, parsed } = loggerInto('debug');
  const builder = SUPERVISOR_EVENTS[name] as (payload: PayloadOf<K>, err?: Error) => ReturnType<Events[K]>;
  writeEvent(logger, builder(SAMPLES[name], err));
  const lines = parsed();
  expect(lines).toHaveLength(1);
  return lines[0] as JsonLine;
};

describe('log-events', () => {
  it('lists exactly the events of §7.2', () => {
    expect(Object.keys(SUPERVISOR_EVENTS).sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it.each(Object.keys(SAMPLES) as Array<keyof Events>)('every supervisor event key survives the logger: %s', (name) => {
    const event = (SUPERVISOR_EVENTS[name] as (payload: unknown) => { msg: string; level: LogLevel; data: Record<string, unknown> })(SAMPLES[name]);
    expect(event.msg).toBe(name);
    expect(event.level).toBe(EXPECTED_LEVELS[name]);
    expect(event.data).toEqual(SAMPLES[name]);
    const line = emit(name);
    expect(line.msg).toBe(name);
    expect(line.level).toBe(EXPECTED_LEVELS[name]);
    expect(line.service).toBe('supervisor');
    expect(line.pid).toBe(process.pid);
    for (const [key, value] of Object.entries(SAMPLES[name])) {
      expect(RESERVED).not.toContain(key);
      expect(line[key]).toEqual(value);
    }
  });

  it('carries the agreed payload names', () => {
    expect(emit('child.ready')).toMatchObject({ child: 'gateway', childPid: 4243 });
    expect(emit('child.external')).toMatchObject({ holderPid: 777 });
    expect(emit('settings.changed')).toMatchObject({ msg: 'settings.changed' });
    expect(emit('settings.record_failed')).toMatchObject({ detail: 'EACCES: permission denied' });
    expect(emit('shutdown.step')).toMatchObject({ shutdownStep: 4 });
    expect(emit('shutdown.step')).not.toHaveProperty('step');
  });

  it('an error travels in err', () => {
    const line = emit('supervisor.background_failed', new Error('random exploded'));
    expect(line).toMatchObject({ msg: 'supervisor.background_failed', level: 'error', source: 'exit-handler' });
    expect(line['err']).toMatchObject({ name: 'Error', message: 'random exploded' });
    expect(supervisorBackgroundFailed({ source: 'lock-poll' }, new Error('x')).err?.message).toBe('x');
  });

  it('orphans.reaped is warn when a marker was kept', () => {
    expect(orphansReaped({ reaped: 0, kept: 1 }).level).toBe('warn');
    expect(orphansReaped({ reaped: 2, kept: 0 }).level).toBe('info');
  });

  it('child.stdout is written at info and appears in a logger whose level is info', () => {
    const { logger, parsed } = loggerInto('info');
    writeEvent(logger, childStdout({ child: 'runtime', childPid: 12, raw: 'hello', rawBytes: 5 }));
    expect(parsed()).toEqual([expect.objectContaining({ msg: 'child.stdout', level: 'info', raw: 'hello', rawBytes: 5, child: 'runtime', childPid: 12 })]);
  });

  it('defineEvent builds events with a fixed or computed level', () => {
    const fixed = defineEvent<{ detail: string }>('test.fixed', 'warn');
    expect(fixed({ detail: 'a' })).toEqual({ level: 'warn', msg: 'test.fixed', data: { detail: 'a' } });
    const computed = defineEvent<{ n: number }>('test.computed', (payload) => (payload.n > 1 ? 'error' : 'debug'));
    expect(computed({ n: 2 }).level).toBe('error');
    expect(computed({ n: 0 }).level).toBe('debug');
    expect(childReadyIgnored({ child: 'gateway', childPid: 9 })).toEqual({ level: 'info', msg: 'child.ready.ignored', data: { child: 'gateway', childPid: 9 } });
  });

  it('a payload with a reserved key does not compile', () => {
    expectTypeOf<{ pid: number }>().not.toMatchTypeOf<EventPayload>();
    expectTypeOf<{ count: number }>().not.toMatchTypeOf<EventPayload>();
    expectTypeOf<{ step: string }>().not.toMatchTypeOf<EventPayload>();
    expectTypeOf<{ childPid: number; holderPid: number }>().toMatchTypeOf<EventPayload>();
    expectTypeOf<DefinableWith<{ child: 'runtime'; childPid: number; pid: number }>>().toEqualTypeOf<false>();
    expectTypeOf<DefinableWith<{ shutdownStep: number; step: string }>>().toEqualTypeOf<false>();
    expectTypeOf<DefinableWith<{ child: 'runtime'; childPid: number }>>().toEqualTypeOf<true>();
  });

  it('child.stop names the superseded stop reason', () => {
    expectTypeOf<PayloadOf<'child.stop'>['superseded']>().toEqualTypeOf<StopReason | undefined>();
    expect(emit('child.stop')).toMatchObject({ stop: 'shutdown', superseded: 'startup-timeout' });
  });
});
