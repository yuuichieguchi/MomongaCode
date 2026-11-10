import { describe, expect, it } from 'vitest';
import * as runtime from '@momonga/runtime';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, SESSION_STATE_IDLE_MS, makeLogger } from './helpers.ts';

type Activity = { lastActivityAt: number; hasActiveRun: boolean } | undefined;

const setup = (activity: Record<string, Activity> = {}) => {
  const clock = createFakeClock(START_MS);
  const logger = makeLogger();
  const store = { sessionActivity: (id: string): Activity => activity[id] };
  const released: string[] = [];
  const states = runtime.createSessionStates({ clock, store, logger, releaseScratch: (sessionId) => void released.push(sessionId) });
  return { clock, logger, states, activity, released };
};

const idle = { lastActivityAt: START_MS, hasActiveRun: false };
const active = { lastActivityAt: START_MS, hasActiveRun: true };

describe('session states (fake timers and fake clock)', () => {
  it('get creates the state with the session cwd and an empty ledger', () => {
    const { states } = setup();

    const state = states.get({ id: 's1', cwd: '/work/project' });

    expect(state.cwd).toBe('/work/project');
    expect(state.readLedger).toBeInstanceOf(Map);
    expect(state.readLedger.size).toBe(0);
    expect(states.get({ id: 's1', cwd: '/work/project' })).toBe(state);
    expect(states.size()).toBe(1);
  });

  it('get fixes the working directory to the session cwd, independent of later shell moves', () => {
    const { states } = setup();

    const state = states.get({ id: 's1', cwd: '/work/project' });
    state.cwd = '/work/project/sub';

    expect(state.workingDirectory).toBe('/work/project');
    expect(states.get({ id: 's1', cwd: '/work/project' }).workingDirectory).toBe('/work/project');
  });

  it('get updates lastUsedAt on every call', () => {
    const { clock, states } = setup({ s1: idle });
    states.get({ id: 's1', cwd: '/w' });
    clock.advance(SESSION_STATE_IDLE_MS - 1);
    states.get({ id: 's1', cwd: '/w' });
    clock.advance(SESSION_STATE_IDLE_MS - 1);

    expect(states.evictIdle(clock.now())).toEqual([]);
    expect(states.has('s1')).toBe(true);

    clock.advance(1);
    expect(states.evictIdle(clock.now())).toEqual(['s1']);
  });

  it('evictIdle drops the whole entry after 30 minutes idle with no active run', () => {
    const { clock, states } = setup({ s1: idle });
    const state = states.get({ id: 's1', cwd: '/w' });
    state.readLedger.set('/w/a.txt', { sha256: 'abc', mtimeMs: 1 });
    clock.advance(SESSION_STATE_IDLE_MS);

    expect(states.evictIdle(clock.now())).toEqual(['s1']);
    expect(states.has('s1')).toBe(false);
    expect(states.size()).toBe(0);
  });

  it('evictIdle keeps an entry idle for 30 minutes when the session has an active run', () => {
    const { clock, states, activity } = setup({ s1: active });
    states.get({ id: 's1', cwd: '/w' });
    clock.advance(SESSION_STATE_IDLE_MS * 3);

    expect(states.evictIdle(clock.now())).toEqual([]);
    expect(states.has('s1')).toBe(true);

    activity.s1 = idle;
    expect(states.evictIdle(clock.now())).toEqual(['s1']);
  });

  it('evictIdle keeps an entry idle for less than 30 minutes', () => {
    const { clock, states } = setup({ s1: idle });
    states.get({ id: 's1', cwd: '/w' });
    clock.advance(SESSION_STATE_IDLE_MS - 1);

    expect(states.evictIdle(clock.now())).toEqual([]);
    expect(states.has('s1')).toBe(true);
  });

  it('evictIdle drops an entry whose session is unknown to the store', () => {
    const { clock, states } = setup({});
    states.get({ id: 'ghost', cwd: '/w' });
    clock.advance(SESSION_STATE_IDLE_MS);

    expect(states.evictIdle(clock.now())).toEqual(['ghost']);
    expect(states.has('ghost')).toBe(false);
  });

  it('evictIdle returns the evicted ids and logs session_state.evicted with count and ids', () => {
    const { clock, states, logger } = setup({ s1: idle, s2: idle, s3: active });
    states.get({ id: 's1', cwd: '/a' });
    states.get({ id: 's2', cwd: '/b' });
    states.get({ id: 's3', cwd: '/c' });
    clock.advance(SESSION_STATE_IDLE_MS);

    const evicted = states.evictIdle(clock.now());

    expect([...evicted].sort()).toEqual(['s1', 's2']);
    const logged = logger.entries.filter((entry) => entry.msg === 'session_state.evicted');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.level).toBe('debug');
    expect(logged[0]?.fields?.count).toBe(2);
    expect([...((logged[0]?.fields?.ids as readonly string[] | undefined) ?? [])].sort()).toEqual(['s1', 's2']);

    expect(states.evictIdle(clock.now())).toEqual([]);
    expect(logger.entries.filter((entry) => entry.msg === 'session_state.evicted')).toHaveLength(1);
  });

  it('a get after eviction creates a fresh entry, and the Bash cwd starts from session.cwd', () => {
    const { clock, states } = setup({ s1: idle });
    const first = states.get({ id: 's1', cwd: '/w' });
    first.cwd = '/w/sub';
    first.readLedger.set('/w/a.txt', { sha256: 'abc', mtimeMs: 1 });
    clock.advance(SESSION_STATE_IDLE_MS);
    states.evictIdle(clock.now());

    const second = states.get({ id: 's1', cwd: '/w' });

    expect(second).not.toBe(first);
    expect(second.cwd).toBe('/w');
    expect(second.readLedger.size).toBe(0);
  });

  it('has reports exactly the live entries', () => {
    const { clock, states } = setup({ old: idle, fresh: idle });
    expect(states.has('old')).toBe(false);
    states.get({ id: 'old', cwd: '/o' });
    clock.advance(SESSION_STATE_IDLE_MS);
    states.get({ id: 'fresh', cwd: '/f' });

    states.evictIdle(clock.now());

    expect(states.has('old')).toBe(false);
    expect(states.has('fresh')).toBe(true);
    expect(states.has('never')).toBe(false);
    expect(states.size()).toBe(1);
  });

  it('ledger sweep: an active run keeps the state at any idle time, and an idle session is evicted only at 30 minutes or more', () => {
    const { clock, states, activity } = setup({ busy: active, quiet: idle });
    states.get({ id: 'busy', cwd: '/b' });
    states.get({ id: 'quiet', cwd: '/q' });

    clock.advance(SESSION_STATE_IDLE_MS - 1);
    expect(states.evictIdle(clock.now())).toEqual([]);

    clock.advance(1);
    expect(states.evictIdle(clock.now())).toEqual(['quiet']);
    expect(states.has('busy')).toBe(true);

    clock.advance(SESSION_STATE_IDLE_MS * 10);
    expect(states.evictIdle(clock.now())).toEqual([]);
    expect(states.has('busy')).toBe(true);

    activity.busy = idle;
    expect(states.evictIdle(clock.now())).toEqual(['busy']);
  });
});
