import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { afterMicrotasks, createFakeClock, createFakeTimers, withTempDir } from '@momonga/testkit';
import { ERROR_KEY_PREFIX, safeChangeKey, watchSettings } from '../src/settings-watch.ts';
import type { SettingsWatch } from '../src/settings-watch.ts';
import { pollUntil } from './support/p2-poll.ts';

type Listener = (eventType: string, filename: string | null) => void;

class FakeWatcher extends EventEmitter {
  closed = 0;
  close(): void {
    this.closed += 1;
  }
}

const fakeWatch = (options: { throws?: boolean } = {}) => {
  const watchers: FakeWatcher[] = [];
  const listeners: Listener[] = [];
  const directories: string[] = [];
  const watch = ((directory: string, ...rest: unknown[]) => {
    directories.push(directory);
    if (options.throws === true) throw Object.assign(new Error('watch EMFILE'), { code: 'EMFILE' });
    const listener = rest.find((value): value is Listener => typeof value === 'function');
    const watcher = new FakeWatcher();
    if (listener !== undefined) {
      listeners.push(listener);
      watcher.on('change', listener);
    }
    watchers.push(watcher);
    return watcher;
  }) as unknown as typeof fs.watch;
  const fire = (filename: string | null, eventType = 'rename'): void => {
    for (const watcher of watchers) watcher.emit('change', eventType, filename);
  };
  return { watch, watchers, directories, fire };
};

const setup = (options: { initialKey?: string; key?: () => string; throws?: boolean; debounceMs?: number; pollMs?: number; onChange?: () => void | Promise<void> } = {}) => {
  const clock = createFakeClock(0);
  const timers = createFakeTimers(clock);
  const fake = fakeWatch({ ...(options.throws === undefined ? {} : { throws: options.throws }) });
  let key = 'k1';
  let calls = 0;
  const warnings: Error[] = [];
  const errors: Error[] = [];
  const watcher: SettingsWatch = watchSettings({
    directory: '/fake/home/.momonga',
    file: 'settings.json',
    debounceMs: options.debounceMs ?? 200,
    pollMs: options.pollMs ?? 2000,
    changeKey: async () => (options.key ?? (() => key))(),
    initialKey: options.initialKey ?? 'k1',
    onChange: () => {
      calls += 1;
      return options.onChange?.();
    },
    onWarning: (error) => void warnings.push(error),
    onError: (error) => void errors.push(error),
    timers,
    watch: fake.watch,
  });
  return {
    timers,
    fake,
    watcher,
    calls: () => calls,
    warnings,
    errors,
    setKey: (next: string) => {
      key = next;
    },
  };
};

describe('safeChangeKey', () => {
  it('returns the key when changeKey succeeds', async () => {
    expect(await safeChangeKey(async () => '1:2:3')).toBe('1:2:3');
    expect(await safeChangeKey(async () => 'missing')).toBe('missing');
  });

  it('changeKey throw maps to a sentinel key', async () => {
    const eio = Object.assign(new Error('stat EIO'), { code: 'EIO' });
    expect(ERROR_KEY_PREFIX).toBe('error:');
    expect(await safeChangeKey(() => Promise.reject(eio))).toBe('error:EIO');
  });
});

describe('watchSettings', () => {
  it('watches the directory, not the file', async () => {
    const { fake, watcher } = setup();
    expect(fake.directories).toEqual(['/fake/home/.momonga']);
    watcher.stop();
  });

  it('a burst of writes is debounced', async () => {
    const { fake, timers, calls, watcher } = setup();
    for (let index = 0; index < 10; index += 1) {
      fake.fire('settings.json', index % 2 === 0 ? 'rename' : 'change');
      await timers.advanceAsync(15);
    }
    expect(calls()).toBe(0);
    await timers.advanceAsync(184);
    expect(calls()).toBe(0);
    await timers.advanceAsync(1);
    expect(calls()).toBe(1);
    await timers.advanceAsync(200);
    expect(calls()).toBe(1);
    watcher.stop();
  });

  it('unrelated files are ignored', async () => {
    const { fake, timers, calls, watcher } = setup();
    fake.fire('other.json');
    fake.fire('settings.json.tmp');
    await timers.advanceAsync(10_000);
    expect(calls()).toBe(0);
    watcher.stop();
  });

  it('null filename counts as a change', async () => {
    const { fake, timers, calls, watcher } = setup();
    fake.fire(null);
    await timers.advanceAsync(200);
    expect(calls()).toBe(1);
    watcher.stop();
  });

  it('polling fallback', async () => {
    const { timers, calls, warnings, errors, setKey, watcher } = setup({ throws: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBeInstanceOf(Error);
    expect(warnings[0]?.message).toContain('EMFILE');
    await timers.advanceAsync(2000 + 200);
    expect(calls()).toBe(0);
    setKey('k2');
    await timers.advanceAsync(2000 + 200);
    expect(calls()).toBe(1);
    await timers.advanceAsync(2000 + 200);
    expect(calls()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(errors).toEqual([]);
    watcher.stop();
  });

  it('watch error falls back to polling', async () => {
    const { fake, timers, calls, warnings, errors, setKey, watcher } = setup();
    expect(warnings).toEqual([]);
    expect(() => fake.watchers[0]?.emit('error', Object.assign(new Error('watch failed'), { code: 'EIO' }))).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBeInstanceOf(Error);
    expect(warnings[0]?.message).toContain('watch failed');
    expect(() => fake.watchers[0]?.emit('error', Object.assign(new Error('watch failed again'), { code: 'EIO' }))).not.toThrow();
    expect(warnings).toHaveLength(1);
    setKey('k2');
    await timers.advanceAsync(2000 + 200);
    expect(calls()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(errors).toEqual([]);
    watcher.stop();
  });

  it('a working watch reports no warning and no error', async () => {
    const { fake, timers, warnings, errors, watcher } = setup();
    fake.fire('settings.json');
    await timers.advanceAsync(10_000);
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
    watcher.stop();
  });

  it('a change whose watch event never arrives is applied by the next poll, with the watch working and no warning', async () => {
    const { timers, calls, warnings, errors, setKey, watcher } = setup();
    setKey('k2');
    await timers.advanceAsync(2000 + 200);
    expect(calls()).toBe(1);
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
    watcher.stop();
  });

  it('seeds from initialKey, not from a key read at construction', async () => {
    const { timers, calls, watcher } = setup({ initialKey: 'seed', key: () => 'already-newer' });
    await timers.advanceAsync(2000 + 200);
    expect(calls()).toBe(1);
    watcher.stop();
  });

  it('changeKey throw schedules onChange and nothing throws out of the timer', async () => {
    let fail = false;
    const { timers, calls, watcher } = setup({
      key: () => {
        if (fail) throw Object.assign(new Error('stat EIO'), { code: 'EIO' });
        return 'k1';
      },
    });
    fail = true;
    await expect(timers.advanceAsync(2000 + 200)).resolves.toBeUndefined();
    expect(calls()).toBe(1);
    watcher.stop();
  });

  it('an onChange that throws does not escape the timer and goes to onError, not onWarning', async () => {
    const exploded = new Error('evaluate exploded');
    const { fake, timers, calls, warnings, errors, watcher } = setup({
      onChange: () => {
        throw exploded;
      },
    });
    fake.fire('settings.json');
    expect(() => timers.advance(200)).not.toThrow();
    await afterMicrotasks();
    expect(calls()).toBe(1);
    expect(errors).toEqual([exploded]);
    expect(warnings).toEqual([]);
    watcher.stop();
  });

  it('stop clears timers and closes the watcher', async () => {
    const { fake, timers, calls, watcher } = setup();
    fake.fire('settings.json');
    expect(timers.pending().length).toBeGreaterThan(0);
    watcher.stop();
    expect(timers.pending()).toEqual([]);
    expect(fake.watchers[0]?.closed).toBe(1);
    fake.fire('settings.json');
    await timers.advanceAsync(10_000);
    expect(calls()).toBe(0);
    expect(timers.pending()).toEqual([]);
  });

  it('a rename-replace triggers one onChange', async (context) => {
    const dir = withTempDir(context);
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{}');
    let calls = 0;
    const errors: Error[] = [];
    const realTimers = {
      setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
      clearTimeout: (handle: unknown): void => clearTimeout(handle as NodeJS.Timeout),
    };
    const keyOf = (): string => {
      const stat = fs.statSync(file, { bigint: true });
      return `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
    };
    const watcher = watchSettings({
      directory: dir,
      file: 'settings.json',
      debounceMs: 200,
      pollMs: 200,
      changeKey: async () => keyOf(),
      initialKey: keyOf(),
      onChange: () => {
        calls += 1;
      },
      onWarning: (error) => void errors.push(error),
      onError: (error) => void errors.push(error),
      timers: realTimers,
    });
    context.onTestFinished(() => watcher.stop());
    const temporary = path.join(dir, '.settings.tmp');
    fs.writeFileSync(temporary, '{"sandbox":"none"}');
    fs.renameSync(temporary, file);
    await pollUntil(() => calls > 0, 8000, 'onChange after rename');
    expect(calls).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe('the work of the watch that is in flight', () => {
  it('idle settles at once when nothing is in flight, and only after an evaluation in flight has ended', async () => {
    const evaluation = Promise.withResolvers<void>();
    const s = setup({ onChange: () => evaluation.promise });
    await s.watcher.idle();
    s.fake.fire('settings.json');
    s.timers.advance(200);
    await afterMicrotasks();
    expect(s.calls()).toBe(1);
    let idle = false;
    void s.watcher.idle().then(() => {
      idle = true;
    });
    await afterMicrotasks();
    expect(idle).toBe(false);
    s.watcher.stop();
    await afterMicrotasks();
    expect(idle).toBe(false);
    evaluation.resolve();
    await s.watcher.idle();
    expect(idle).toBe(true);
    expect(s.errors).toEqual([]);
  });
});
