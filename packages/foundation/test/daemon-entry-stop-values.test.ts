import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMON_ENTRY_FLAGS, DEFAULT_STOP_VALUES, ENTRY_HARD_EXIT_MARGIN_MS, formatStopMessage, runDaemonEntry, hostPaths } from '@momonga/foundation';
import type { DaemonCloseResult, DaemonDefinition, DaemonHandle, DaemonStartContext, EntryIo, EntrySignal, StopValues } from '@momonga/foundation';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';

const HOME = '/Users/alice';
const START_MS = 1_800_000_000_000;
const ARGV = [`--home=${HOME}`, '--log-target=stderr', '--lifeline-fd=3'];

type Flags = typeof COMMON_ENTRY_FLAGS;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

const boundOf = (values: StopValues): number => values.closeGraceMs + 2 * values.managedServerStopGraceMs + 3 * values.drainTimeoutMs + 5 * values.mcpCloseGraceMs;

const launch = async () => {
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const signalHandlers = new Map<EntrySignal, Array<() => void>>();
  const lifelines: Array<{ onEnd(): void; onLine(line: string): void }> = [];
  const stderr: string[] = [];
  const unread: string[] = [];
  const io: EntryIo = {
    argv: ARGV,
    env: { HOME },
    home: HOME,
    paths: hostPaths,
    stdout: { write: () => true },
    stderr: { write: (chunk) => (stderr.push(chunk), true) },
    clock,
    timers,
    onSignal: (signal, handler) => {
      signalHandlers.set(signal, [...(signalHandlers.get(signal) ?? []), handler]);
      return () => undefined;
    },
    onUncaught: () => () => undefined,
    watchLifeline: (_fd, handlers) => {
      lifelines.push(handlers);
      return {
        dispose: () => undefined,
        drain: async () => {
          await new Promise((resolve) => setImmediate(resolve));
          for (const text of unread.splice(0)) handlers.onLine(text);
        },
      };
    },
    holdOpen: () => () => undefined,
    logFile: () => ({ write: () => undefined, close: () => undefined, droppedLines: 0 }),
    exit: () => undefined,
  };
  let fileValues: StopValues = { closeGraceMs: 7, managedServerStopGraceMs: 3, drainTimeoutMs: 11, mcpCloseGraceMs: 13 };
  let fileInvalid = false;
  const notices: string[] = [];
  const reads: StopValues[] = [];
  const closes: StopValues[] = [];
  const contexts: Array<DaemonStartContext<Flags>> = [];
  const result = Promise.withResolvers<DaemonCloseResult>();
  const handle: DaemonHandle = {
    close: (values: StopValues) => {
      closes.push(values);
      return result.promise;
    },
    abort: () => result.promise,
    fatal: new Promise<Error>(() => undefined),
  };
  const definition: DaemonDefinition<Flags> = {
    service: 'gateway',
    version: '1.0.0',
    flags: COMMON_ENTRY_FLAGS,
    maxCloseMs: (_flags, values) => boundOf(values),
    readStopValues: () => {
      reads.push(fileValues);
      if (fileInvalid) {
        notices.push('the stop values could not be read from the user settings; the default values were used');
        return DEFAULT_STOP_VALUES;
      }
      return fileValues;
    },
    ownLockPath: (home) => path.join(home, 'gateway.lock'),
    logPath: (home) => path.join(home, 'gateway.log'),
    isConfigError: () => false,
    start: async (context) => {
      contexts.push(context);
      return handle;
    },
  };
  void runDaemonEntry(io, definition);
  await settle();
  return {
    timers,
    reads,
    notices,
    closes,
    invalidateFile: () => {
      fileInvalid = true;
    },
    contexts,
    stderr: () => stderr.join(''),
    setFile: (values: StopValues) => {
      fileValues = values;
    },
    arriveUnread: (text: string) => {
      unread.push(text);
    },
    line: (text: string) => {
      for (const lifeline of lifelines) lifeline.onLine(text);
    },
    eof: () => {
      for (const lifeline of lifelines) lifeline.onEnd();
    },
    signal: (name: EntrySignal) => {
      for (const handler of signalHandlers.get(name) ?? []) handler();
    },
    deadlines: () => timers.pending().map((timer) => timer.delayMs),
  };
};

const FILE: StopValues = { closeGraceMs: 7, managedServerStopGraceMs: 3, drainTimeoutMs: 11, mcpCloseGraceMs: 13 };
const MESSAGE: StopValues = { closeGraceMs: 42, managedServerStopGraceMs: 5, drainTimeoutMs: 4321, mcpCloseGraceMs: 17 };

describe('a stop carries the four values read at its begin', () => {
  it('the two-value line of revision 6 is malformed, so the close reads the file and warns once', async () => {
    const entry = await launch();
    entry.line('{"event":"stop","closeGraceMs":42,"managedServerStopGraceMs":5}');
    entry.signal('SIGTERM');
    await settle();
    expect(entry.closes).toEqual([FILE]);
    expect(entry.stderr().split('the stop message was malformed and was ignored: ').length - 1).toBe(1);
  });

  it('a stop message carries the runtime drain and the MCP grace to the close and to its deadline', async () => {
    const entry = await launch();
    entry.line('{"event":"stop","closeGraceMs":42,"managedServerStopGraceMs":5,"drainTimeoutMs":4321,"mcpCloseGraceMs":17}');
    entry.signal('SIGTERM');
    await settle();
    expect(entry.closes).toEqual([{ closeGraceMs: 42, managedServerStopGraceMs: 5, drainTimeoutMs: 4321, mcpCloseGraceMs: 17 }]);
    expect(entry.deadlines()).toEqual([42 + 10 + 12_963 + 85 + ENTRY_HARD_EXIT_MARGIN_MS]);
  });

  it('a stop message followed by SIGTERM closes with the message values, never the file, even when the file changed in between', async () => {
    const entry = await launch();
    entry.line(formatStopMessage(MESSAGE).trimEnd());
    entry.setFile({ closeGraceMs: 999, managedServerStopGraceMs: 999, drainTimeoutMs: 999, mcpCloseGraceMs: 999 });
    entry.signal('SIGTERM');
    await settle();
    expect(entry.closes).toEqual([MESSAGE]);
    expect(entry.reads).toEqual([]);
    expect(entry.deadlines()).toEqual([boundOf(MESSAGE) + ENTRY_HARD_EXIT_MARGIN_MS]);
  });

  it('a stop message followed by end of stream closes with the message values', async () => {
    const entry = await launch();
    entry.line(formatStopMessage(MESSAGE).trimEnd());
    entry.eof();
    await settle();
    expect(entry.closes).toEqual([MESSAGE]);
    expect(entry.reads).toEqual([]);
  });

  it('a SIGTERM with no stop message reads the file once at the begin, and a later change does not move the deadline', async () => {
    const entry = await launch();
    entry.signal('SIGTERM');
    await settle();
    expect(entry.reads).toEqual([{ closeGraceMs: 7, managedServerStopGraceMs: 3, drainTimeoutMs: 11, mcpCloseGraceMs: 13 }]);
    entry.setFile({ closeGraceMs: 999, managedServerStopGraceMs: 999, drainTimeoutMs: 999, mcpCloseGraceMs: 999 });
    entry.signal('SIGTERM');
    await settle();
    expect(entry.reads).toEqual([{ closeGraceMs: 7, managedServerStopGraceMs: 3, drainTimeoutMs: 11, mcpCloseGraceMs: 13 }]);
    expect(entry.closes).toEqual([{ closeGraceMs: 7, managedServerStopGraceMs: 3, drainTimeoutMs: 11, mcpCloseGraceMs: 13 }]);
    expect(entry.deadlines()).toEqual([boundOf({ closeGraceMs: 7, managedServerStopGraceMs: 3, drainTimeoutMs: 11, mcpCloseGraceMs: 13 }) + ENTRY_HARD_EXIT_MARGIN_MS]);
  });

  it('a requested stop with values uses them and reads nothing', async () => {
    const entry = await launch();
    entry.contexts[0]?.requestShutdown(MESSAGE);
    await settle();
    expect(entry.closes).toEqual([MESSAGE]);
    expect(entry.reads).toEqual([]);
    expect(entry.deadlines()).toEqual([boundOf(MESSAGE) + ENTRY_HARD_EXIT_MARGIN_MS]);
  });

  it('a close that begins with only malformed lines reads the file at its begin and logs the malformed line once in English', async () => {
    const entry = await launch();
    entry.line('{"event":"stop","closeGraceMs":1,"managedServerStopGraceMs":1,"drainTimeoutMs":-1,"mcpCloseGraceMs":1}');
    entry.signal('SIGTERM');
    await settle();
    expect(entry.reads).toEqual([{ closeGraceMs: 7, managedServerStopGraceMs: 3, drainTimeoutMs: 11, mcpCloseGraceMs: 13 }]);
    expect(entry.closes).toEqual([{ closeGraceMs: 7, managedServerStopGraceMs: 3, drainTimeoutMs: 11, mcpCloseGraceMs: 13 }]);
    expect(entry.stderr().split('the stop message was malformed and was ignored: ').length - 1).toBe(1);
    expect(entry.stderr()).not.toContain('the default values were used');
  });

  it('a line with a field beyond the five is malformed and the close reads the file', async () => {
    const entry = await launch();
    entry.line('{"event":"stop","closeGraceMs":42,"managedServerStopGraceMs":5,"drainTimeoutMs":6,"mcpCloseGraceMs":7,"extra":1}');
    entry.signal('SIGTERM');
    await settle();
    expect(entry.closes).toEqual([{ closeGraceMs: 7, managedServerStopGraceMs: 3, drainTimeoutMs: 11, mcpCloseGraceMs: 13 }]);
    expect(entry.stderr()).toContain('the stop message was malformed and was ignored: ');
  });

  it('a second valid message is ignored with the malformed-message warning naming the reason, and nothing after the begin changes the values', async () => {
    const entry = await launch();
    entry.line(formatStopMessage(MESSAGE).trimEnd());
    entry.line(formatStopMessage({ closeGraceMs: 1, managedServerStopGraceMs: 1, drainTimeoutMs: 1, mcpCloseGraceMs: 1 }).trimEnd());
    entry.signal('SIGTERM');
    entry.line(formatStopMessage({ closeGraceMs: 2, managedServerStopGraceMs: 2, drainTimeoutMs: 2, mcpCloseGraceMs: 2 }).trimEnd());
    await settle();
    expect(entry.closes).toEqual([MESSAGE]);
    expect(entry.reads).toEqual([]);
    expect(entry.deadlines()).toEqual([boundOf(MESSAGE) + ENTRY_HARD_EXIT_MARGIN_MS]);
    expect(entry.stderr()).toContain('the stop message was malformed and was ignored: a stop message was already received');
  });

  it('drains the lifeline before taking values: a message already delivered but not yet read when SIGTERM arrives sets the values of the close', async () => {
    const entry = await launch();
    entry.arriveUnread(formatStopMessage(MESSAGE).trimEnd());
    entry.setFile({ closeGraceMs: 999, managedServerStopGraceMs: 999, drainTimeoutMs: 999, mcpCloseGraceMs: 999 });
    entry.signal('SIGTERM');
    await settle();
    expect(entry.closes).toEqual([MESSAGE]);
    expect(entry.reads).toEqual([]);
    expect(entry.deadlines()).toEqual([boundOf(MESSAGE) + ENTRY_HARD_EXIT_MARGIN_MS]);
  });

  it('with an invalid settings file and a valid message waiting in the drain, applies the message and gives no defaults notice', async () => {
    const entry = await launch();
    entry.invalidateFile();
    entry.arriveUnread(formatStopMessage(MESSAGE).trimEnd());
    entry.signal('SIGTERM');
    await settle();
    expect(entry.closes).toEqual([MESSAGE]);
    expect(entry.reads).toEqual([]);
    expect(entry.notices).toEqual([]);
  });

  it('with an invalid settings file and no valid message, applies the defaults and gives the notice once', async () => {
    const entry = await launch();
    entry.invalidateFile();
    entry.line('not a stop message');
    entry.signal('SIGTERM');
    entry.signal('SIGTERM');
    await settle();
    expect(entry.closes).toEqual([DEFAULT_STOP_VALUES]);
    expect(entry.notices).toHaveLength(1);
  });
});
