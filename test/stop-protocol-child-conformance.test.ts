import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMON_ENTRY_FLAGS, formatStopMessage, hostPaths, runDaemonEntry } from '@momonga/foundation';
import type { DaemonCloseResult, DaemonDefinition, DaemonHandle, DaemonStartContext, EntryIo, EntrySignal, StopValues } from '@momonga/foundation';
import { afterMicrotasks, createFakeClock, createFakeTimers, testLocks, waitFor } from '@momonga/testkit';

const specPath = path.resolve(import.meta.dirname, '..', 'specs', 'tla', 'StopProtocol.tla');
const spec = fs.readFileSync(specPath, 'utf8');

const bodyOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start < 0) throw new Error(`${name} is not defined in ${specPath}`);
  const rest = spec.slice(start);
  const next = rest.search(/\n\S/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

const HOME = '/Users/alice';
const FILE: StopValues = { closeGraceMs: 7, managedServerStopGraceMs: 3, drainTimeoutMs: 11, mcpCloseGraceMs: 13 };
const CHANGED: StopValues = { closeGraceMs: 8, managedServerStopGraceMs: 4, drainTimeoutMs: 12, mcpCloseGraceMs: 14 };
const MESSAGE: StopValues = { closeGraceMs: 42, managedServerStopGraceMs: 5, drainTimeoutMs: 4321, mcpCloseGraceMs: 17 };
const IGNORED_LATE = 'the stop message was malformed and was ignored: the stop had already taken its values';

type Flags = typeof COMMON_ENTRY_FLAGS;

const launchChild = async () => {
  const clock = createFakeClock(1_800_000_000_000);
  const timers = createFakeTimers(clock);
  const signalHandlers = new Map<EntrySignal, Array<() => void>>();
  const lifelines: Array<{ onEnd(): void; onLine(line: string): void }> = [];
  const stderr: string[] = [];
  const delivered: string[] = [];
  let fileValues = FILE;
  const reads: StopValues[] = [];
  const closes: StopValues[] = [];
  const contexts: Array<DaemonStartContext<Flags>> = [];
  const result = Promise.withResolvers<DaemonCloseResult>();
  const io: EntryIo = {
    platform: process.platform,
    argv: [`--home=${HOME}`, '--log-target=stderr', '--lifeline-fd=3'],
    env: { HOME },
    home: HOME,
    locks: testLocks,
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
          await afterMicrotasks();
          for (const text of delivered.splice(0)) handlers.onLine(text);
        },
      };
    },
    holdOpen: () => () => undefined,
    logFile: () => ({ write: () => undefined, close: () => undefined, droppedLines: 0 }),
    exit: () => undefined,
  };
  const handle: DaemonHandle = {
    close: (values: StopValues) => {
      closes.push(values);
      return result.promise;
    },
    abort: (values: StopValues) => {
      closes.push(values);
      return result.promise;
    },
    fatal: new Promise<Error>(() => undefined),
  };
  const definition: DaemonDefinition<Flags> = {
    service: 'runtime',
    version: '1.0.0',
    flags: COMMON_ENTRY_FLAGS,
    maxCloseMs: (_flags, values) => values.drainTimeoutMs,
    readStopValues: () => {
      reads.push(fileValues);
      return fileValues;
    },
    ownLockPath: (home) => path.join(home, 'runtime.lock'),
    logPath: (home) => path.join(home, 'runtime.log'),
    isConfigError: () => false,
    start: async (context) => {
      contexts.push(context);
      return handle;
    },
  };
  void runDaemonEntry(io, definition);
  await waitFor(() => contexts.length === 1, { description: 'the start of the runtime child' });
  return {
    reads,
    closes,
    stderr: () => stderr.join(''),
    setFile: (values: StopValues) => {
      fileValues = values;
    },
    rtWriteDone: (values: StopValues) => {
      delivered.push(formatStopMessage(values).trimEnd());
    },
    childRead: () => {
      for (const text of delivered.splice(0)) for (const lifeline of lifelines) lifeline.onLine(text);
    },
    signal: (name: EntrySignal) => {
      for (const handler of signalHandlers.get(name) ?? []) handler();
    },
    selfBegin: () => {
      for (const lifeline of lifelines) lifeline.onEnd();
    },
    taken: () => waitFor(() => closes.length === 1, { description: 'the child to take its values and begin its close' }),
  };
};

describe('StopProtocol.tla states the runtime child share of the stop message the way daemon-entry.ts receives it', () => {
  it('the model drains before it takes, takes a received message before the file, and ignores a message after the take', () => {
    expect(bodyOf('Drains')).toContain('rpipe[g] /\\ Variant # "takeBeforeDrain"');
    expect(bodyOf('ChildTake')).toContain(`rtv' = [rtv EXCEPT ![g].applied = IF rrecv[g] # 0 THEN rrecv[g] ELSE IF Drains(g) THEN rtv[g].carry ELSE file]`);
    expect(bodyOf('ChildRead')).toContain('IF rtaken[g] \\/ rrecv[g] # 0 THEN rrecv[g] ELSE rtv[g].carry');
    expect(bodyOf('ChildRead')).toContain('rtaken[g] /\\ Variant = "lateApplies"');
    expect(bodyOf('ChildBegin')).toContain('(how = "self" \\/ rsig[g])');
    expect(bodyOf('RtWriteDone')).toContain(`rsig' = [rsig EXCEPT ![g] = TRUE]`);
    expect(bodyOf('RtWriteFailed')).toContain('"killing"');
    expect(bodyOf('SameValues')).toContain('(rtaken[g] /\\ rhow[g] = "signal") => rtv[g].applied = sv[g]');
  });

  it('RtWriteDone, ChildRead, ChildBegin(signal), ChildTake: a message read before the signal sets the values of the close and the file is not read', async () => {
    const child = await launchChild();
    child.rtWriteDone(MESSAGE);
    child.childRead();
    child.setFile(CHANGED);
    child.signal('SIGTERM');
    await child.taken();
    expect(child.closes).toEqual([MESSAGE]);
    expect(child.reads).toEqual([]);
  });

  it('RtWriteDone, ChildBegin(signal), ChildTake with Drains: a message delivered but unread when the signal arrives is drained and applied', async () => {
    const child = await launchChild();
    child.rtWriteDone(MESSAGE);
    child.signal('SIGTERM');
    await child.taken();
    expect(child.closes).toEqual([MESSAGE]);
    expect(child.reads).toEqual([]);
  });

  it('a lost message (RtWriteFailed: no line, no signal) leaves a child that began its own exit on the file read at its take (ChildValues)', async () => {
    const child = await launchChild();
    child.selfBegin();
    await child.taken();
    expect(child.closes).toEqual([FILE]);
    expect(child.reads).toEqual([FILE]);
  });

  it('a message arriving after the child began its own exit and took its values changes nothing (ValuesFixed) and is logged as ignored', async () => {
    const child = await launchChild();
    child.selfBegin();
    await child.taken();
    child.rtWriteDone(MESSAGE);
    child.childRead();
    await afterMicrotasks();
    child.signal('SIGTERM');
    await afterMicrotasks();
    expect(child.closes[0]).toEqual(FILE);
    expect(child.closes.every((values) => JSON.stringify(values) === JSON.stringify(FILE))).toBe(true);
    expect(child.reads).toEqual([FILE]);
    expect(child.stderr()).toContain(IGNORED_LATE);
  });

  it('a message delivered before the child began its own exit is drained at the take and applied (ChildBegin(self) after RtWriteDone)', async () => {
    const child = await launchChild();
    child.rtWriteDone(MESSAGE);
    child.selfBegin();
    await child.taken();
    expect(child.closes).toEqual([MESSAGE]);
    expect(child.reads).toEqual([]);
  });
});
