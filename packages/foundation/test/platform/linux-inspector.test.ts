import { describe, expect, it } from 'vitest';
import { BOOT_TIME_RESOLUTION_MS, createLinuxInspector } from '../../src/platform/linux-inspector.ts';
import { auxvLayoutOf, isPidDirectoryName, parseBootTimeSeconds, parseRealUid, parseClockTicksPerSecond, parseProcStat } from '../../src/platform/linux-parsers.ts';
import { PS_PROBE_TIMEOUT_MS, REAP_POLL_INTERVAL_MS } from '../../src/platform/probe-timing.ts';
import type { FileIdentity, ProcFs } from '../../src/platform/procfs.ts';

const STAT_SLEEP = '4242 (sleep) S 4200 4242 4200 34816 4242 4194304 120 0 0 0 0 0 0 0 20 0 1 0 987654 5517312 189 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0';
const STAT_ZOMBIE = STAT_SLEEP.replace(' S ', ' Z ');
const STAT_AWKWARD_COMM = '77 (a) b (c)) R 1 77 77 0 -1 4194560 10 0 0 0 1 2 0 0 20 0 4 0 5000 1000 10 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0';

const auxvOf = (pairs: Array<[bigint, bigint]>): Uint8Array => {
  const buffer = new ArrayBuffer(pairs.length * 16);
  const view = new DataView(buffer);
  pairs.forEach(([type, value], index) => {
    view.setBigUint64(index * 16, type, true);
    view.setBigUint64(index * 16 + 8, value, true);
  });
  return new Uint8Array(buffer);
};

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

type FakeEntry = { text?: string; bytes?: Uint8Array; children?: string[]; identity?: FileIdentity; failure?: string; birthMs?: number };

const statusOwnedBy = (uid: number): FakeEntry => ({ text: `Name:\tx\nState:\tS (sleeping)\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n` });

const fakeProcfs = (entries: Record<string, FakeEntry>): ProcFs => {
  const lookup = (file: string): FakeEntry => {
    const entry = entries[file];
    if (entry === undefined) throw errno('ENOENT');
    if (entry.failure !== undefined) throw errno(entry.failure);
    return entry;
  };
  return {
    readText: async (file) => lookup(file).text ?? '',
    readBytes: async (file) => lookup(file).bytes ?? new Uint8Array(),
    list: async (directory) => lookup(directory).children ?? [],
    identityOf: async (file) => lookup(file).identity ?? { dev: 0n, ino: 0n },
    birthMsOf: async (file) => lookup(file).birthMs ?? 0,
  };
};

const fakeTiming = () => {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (ms: number): Promise<void> => {
      elapsed += ms;
    },
    slept: () => elapsed,
  };
};

const LAYOUT = auxvLayoutOf('x64', 'LE');
const UID = 1000;
const BASE_ENTRIES: Record<string, FakeEntry> = {
  '/proc/stat': { text: 'cpu  1 2 3 4\nbtime 1700000000\nprocesses 5\n' },
  '/proc/self/auxv': { bytes: auxvOf([[33n, 140737488355328n], [17n, 100n], [0n, 0n]]) },
};

describe('proc parsers (formats from proc_pid_stat(5), proc_stat(5), getauxval(3))', () => {
  it('reads state, parent, group and starttime from the field after comm', () => {
    expect(parseProcStat(STAT_SLEEP)).toEqual({ state: 'S', parentPid: 4200, groupId: 4242, startTicks: 987654n });
  });

  it('splits after the last closing parenthesis when comm contains parentheses and spaces', () => {
    expect(parseProcStat(STAT_AWKWARD_COMM)).toEqual({ state: 'R', parentPid: 1, groupId: 77, startTicks: 5000n });
  });

  it('rejects a stat line without comm parentheses, with too few fields, or with a non-numeric starttime', () => {
    expect(() => parseProcStat('12 sleep S 1')).toThrow('closing parenthesis');
    expect(() => parseProcStat('12 (sleep) S 1 12')).toThrow('too few fields');
    expect(() => parseProcStat(STAT_SLEEP.replace('987654', 'abc'))).toThrow('non-numeric');
  });

  it('reads btime in seconds', () => {
    expect(parseBootTimeSeconds('cpu 1 2\nbtime 769041601\nprocesses 86031\n')).toBe(769041601);
    expect(() => parseBootTimeSeconds('cpu 1 2\n')).toThrow('btime');
  });

  it('finds AT_CLKTCK in a 64-bit little-endian auxiliary vector and a 32-bit big-endian one', () => {
    expect(parseClockTicksPerSecond(auxvOf([[33n, 1n], [17n, 100n], [0n, 0n]]), LAYOUT)).toBe(100);
    const big = new DataView(new ArrayBuffer(16));
    big.setUint32(0, 17, false);
    big.setUint32(4, 1024, false);
    expect(parseClockTicksPerSecond(new Uint8Array(big.buffer), { wordBytes: 4, littleEndian: false })).toBe(1024);
  });

  it('stops at AT_NULL and fails when AT_CLKTCK is absent', () => {
    expect(() => parseClockTicksPerSecond(auxvOf([[33n, 1n], [0n, 0n], [17n, 100n]]), LAYOUT)).toThrow('AT_CLKTCK');
  });

  it('derives the auxv layout from the architecture', () => {
    expect(auxvLayoutOf('arm64', 'LE')).toEqual({ wordBytes: 8, littleEndian: true });
    expect(auxvLayoutOf('ia32', 'LE')).toEqual({ wordBytes: 4, littleEndian: true });
  });

  it('recognises process directories in /proc listings', () => {
    expect(['1', '4242', 'self', 'sys', '0', '012'].filter(isPidDirectoryName)).toEqual(['1', '4242']);
  });
});

describe('linux inspector through an injected procfs', () => {
  it('computes the start time as boot time plus starttime ticks', async () => {
    const inspector = createLinuxInspector({ procfs: fakeProcfs({ ...BASE_ENTRIES, '/proc/4242/stat': { text: STAT_SLEEP } }), layout: LAYOUT, uid: UID });
    expect(await inspector.startTimeOf(4242)).toEqual({ kind: 'value', value: 1700000000000 + 9876540 });
  });

  it('reports a missing process as gone and a failed read as a failure classified by errno', async () => {
    const inspector = createLinuxInspector({
      procfs: fakeProcfs({ ...BASE_ENTRIES, '/proc/9/stat': { failure: 'EIO' }, '/proc/10/stat': { failure: 'EACCES' } }),
      layout: LAYOUT,
      uid: UID,
    });
    expect(await inspector.startTimeOf(8)).toEqual({ kind: 'gone' });
    expect(await inspector.startTimeOf(9)).toMatchObject({ kind: 'failed', cause: 'transient', evidence: { kind: 'errno', code: 'EIO' } });
    expect(await inspector.startTimeOf(10)).toMatchObject({ kind: 'failed', cause: 'deterministic', evidence: { kind: 'errno', code: 'EACCES' } });
  });

  it('reports a stat line it cannot parse as a deterministic failure', async () => {
    const inspector = createLinuxInspector({ procfs: fakeProcfs({ ...BASE_ENTRIES, '/proc/7/stat': { text: '7 broken' } }), layout: LAYOUT, uid: UID });
    expect(await inspector.startTimeOf(7)).toMatchObject({ kind: 'failed', cause: 'deterministic', evidence: { kind: 'unparseable' } });
  });

  it('reads boot parameters once after they were read successfully', async () => {
    let reads = 0;
    const procfs = fakeProcfs({ ...BASE_ENTRIES, '/proc/4242/stat': { text: STAT_SLEEP } });
    const counting: ProcFs = { ...procfs, readText: (file) => ((reads += file === '/proc/stat' ? 1 : 0), procfs.readText(file)) };
    const inspector = createLinuxInspector({ procfs: counting, layout: LAYOUT, uid: UID });
    await inspector.startTimeOf(4242);
    await inspector.startTimeOf(4242);
    expect(reads).toBe(1);
  });

  it('does not cache a failed read of the boot parameters', async () => {
    let failing = true;
    const procfs = fakeProcfs({ ...BASE_ENTRIES, '/proc/4242/stat': { text: STAT_SLEEP } });
    const flaky: ProcFs = {
      ...procfs,
      readText: (file) => {
        if (file === '/proc/stat' && failing) return Promise.reject(errno('EMFILE'));
        return procfs.readText(file);
      },
    };
    const inspector = createLinuxInspector({ procfs: flaky, layout: LAYOUT, uid: UID });
    expect(await inspector.startTimeOf(4242)).toMatchObject({ kind: 'failed', cause: 'transient' });
    failing = false;
    expect(await inspector.startTimeOf(4242)).toEqual({ kind: 'value', value: 1700000000000 + 9876540 });
  });

  it('lists the pids whose descriptors resolve to the marker file identity, skipping processes of other users whose descriptors are denied', async () => {
    const marker = { dev: 64769n, ino: 5000n };
    const procfs = fakeProcfs({
      '/marker': { identity: marker },
      '/proc': { children: ['self', 'sys', '10', '11', '12', '13', '14'] },
      '/proc/10/fd': { children: ['0', '3'] },
      '/proc/10/fd/0': { identity: { dev: 1n, ino: 1n } },
      '/proc/10/fd/3': { identity: marker },
      '/proc/11/fd': { children: ['0'] },
      '/proc/11/fd/0': { identity: { dev: 64769n, ino: 5001n } },
      '/proc/12/fd': { failure: 'EACCES' },
      '/proc/12/status': statusOwnedBy(0),
      '/proc/12/stat': { text: STAT_SLEEP },
      '/proc/13/fd': { children: ['4', '5'] },
      '/proc/13/fd/4': { failure: 'ENOENT' },
      '/proc/13/fd/5': { identity: marker },
    });
    const inspector = createLinuxInspector({ procfs, layout: LAYOUT, uid: UID });
    expect(await inspector.holdersOf('/marker')).toEqual({ kind: 'value', value: [10, 13] });
  });

  it('does not call a same-user process with unreadable descriptors "not a holder": the answer is unknown now and may be known after its exec completes', async () => {
    const procfs = fakeProcfs({
      '/marker': { identity: { dev: 1n, ino: 1n } },
      '/proc': { children: ['12'] },
      '/proc/12/fd': { failure: 'EACCES' },
      '/proc/12/status': statusOwnedBy(UID),
      '/proc/12/stat': { text: STAT_SLEEP },
    });
    const timing = fakeTiming();
    const result = await createLinuxInspector({ procfs, layout: LAYOUT, uid: UID, timing }).holdersOf('/marker');
    expect(result).toMatchObject({ kind: 'failed', cause: 'deterministic', evidence: { kind: 'opaque' } });
    expect(result.kind === 'failed' ? result.evidence.detail : '').toContain('process 12 belongs to the current user');
    expect(timing.slept()).toBe(Math.ceil(PS_PROBE_TIMEOUT_MS / REAP_POLL_INTERVAL_MS) * REAP_POLL_INTERVAL_MS);
  });

  it('waits for a same-user process to become readable and then reads it', async () => {
    const marker = { dev: 1n, ino: 1n };
    const entries: Record<string, FakeEntry> = {
      '/marker': { identity: marker },
      '/proc': { children: ['12'] },
      '/proc/12/stat': { text: STAT_SLEEP },
      '/proc/12/status': statusOwnedBy(UID),
      '/proc/12/fd': { children: ['3'] },
      '/proc/12/fd/3': { identity: marker },
    };
    const inner = fakeProcfs(entries);
    let refusals = 3;
    const procfs: ProcFs = {
      ...inner,
      list: (directory) => {
        if (directory !== '/proc/12/fd' || refusals === 0) return inner.list(directory);
        refusals -= 1;
        return Promise.reject(errno('EACCES'));
      },
    };
    const timing = fakeTiming();
    expect(await createLinuxInspector({ procfs, layout: LAYOUT, uid: UID, timing }).holdersOf('/marker')).toEqual({ kind: 'value', value: [12] });
    expect(timing.slept()).toBe(3 * REAP_POLL_INTERVAL_MS);
  });

  it('treats a zombie whose descriptor directory is denied as holding nothing, even when it is owned by the current user', async () => {
    const marker = { dev: 1n, ino: 1n };
    const procfs = fakeProcfs({
      '/marker': { identity: marker },
      '/proc': { children: ['12', '13'] },
      '/proc/12/fd': { failure: 'EACCES' },
      '/proc/12/status': statusOwnedBy(UID),
      '/proc/12/stat': { text: STAT_ZOMBIE },
      '/proc/13/fd': { children: ['3'] },
      '/proc/13/fd/3': { identity: marker },
    });
    expect(await createLinuxInspector({ procfs, layout: LAYOUT, uid: UID }).holdersOf('/marker')).toEqual({ kind: 'value', value: [13] });
  });

  it('treats a descriptor that is denied because its process became a zombie as not holding the marker', async () => {
    const marker = { dev: 1n, ino: 1n };
    const procfs = fakeProcfs({
      '/marker': { identity: marker },
      '/proc': { children: ['12'] },
      '/proc/12/fd': { children: ['3'] },
      '/proc/12/fd/3': { failure: 'EACCES' },
      '/proc/12/stat': { text: STAT_ZOMBIE },
    });
    expect(await createLinuxInspector({ procfs, layout: LAYOUT, uid: UID }).holdersOf('/marker')).toEqual({ kind: 'value', value: [] });
  });

  it('keeps a denied descriptor of a live same-user process an unknown answer and skips one of another user', async () => {
    const entries = (uid: number): Record<string, FakeEntry> => ({
      '/marker': { identity: { dev: 1n, ino: 1n } },
      '/proc': { children: ['12'] },
      '/proc/12/fd': { children: ['3'] },
      '/proc/12/fd/3': { failure: 'EACCES' },
      '/proc/12/stat': { text: STAT_SLEEP },
      '/proc/12/status': statusOwnedBy(uid),
    });
    expect(await createLinuxInspector({ procfs: fakeProcfs(entries(UID)), layout: LAYOUT, uid: UID, timing: fakeTiming() }).holdersOf('/marker')).toMatchObject({
      kind: 'failed',
      cause: 'deterministic',
      evidence: { kind: 'opaque' },
    });
    expect(await createLinuxInspector({ procfs: fakeProcfs(entries(0)), layout: LAYOUT, uid: UID, timing: fakeTiming() }).holdersOf('/marker')).toEqual({ kind: 'value', value: [] });
  });

  describe('a same-user process that stays non-dumpable (ssh-agent, a setuid helper that kept the real uid)', () => {
    const SLEEP_STARTED_MS = 1_700_000_000_000 + 9_876_540;
    const TICK_MS = 1000 / 100;
    const entriesFor = (birthMs: number): Record<string, FakeEntry> => ({
      ...BASE_ENTRIES,
      '/marker': { identity: { dev: 1n, ino: 1n }, birthMs },
      '/proc': { children: ['12'] },
      '/proc/12/fd': { failure: 'EACCES' },
      '/proc/12/stat': { text: STAT_SLEEP },
      '/proc/12/status': statusOwnedBy(UID),
    });

    it('holds nothing when it started before the marker existed, and the probe does not wait for it', async () => {
      const timing = fakeTiming();
      const inspector = createLinuxInspector({ procfs: fakeProcfs(entriesFor(SLEEP_STARTED_MS + BOOT_TIME_RESOLUTION_MS + TICK_MS + 1)), layout: LAYOUT, uid: UID, timing });
      expect(await inspector.holdersOf('/marker')).toEqual({ kind: 'value', value: [] });
      expect(timing.slept()).toBe(0);
    });

    it('is not skipped when the marker is younger by less than the resolution of btime and of the clock tick', async () => {
      const timing = fakeTiming();
      const inspector = createLinuxInspector({ procfs: fakeProcfs(entriesFor(SLEEP_STARTED_MS + BOOT_TIME_RESOLUTION_MS + TICK_MS - 1)), layout: LAYOUT, uid: UID, timing });
      expect(await inspector.holdersOf('/marker')).toMatchObject({ kind: 'failed', evidence: { kind: 'opaque' } });
      expect(timing.slept()).toBeGreaterThanOrEqual(PS_PROBE_TIMEOUT_MS);
    });

    it('stays unreadable, named by its pid, when it started after the marker', async () => {
      const result = await createLinuxInspector({ procfs: fakeProcfs(entriesFor(SLEEP_STARTED_MS - 1)), layout: LAYOUT, uid: UID, timing: fakeTiming() }).holdersOf('/marker');
      expect(result).toMatchObject({ kind: 'failed', cause: 'deterministic', evidence: { kind: 'opaque' } });
      expect(JSON.stringify(result)).toContain('process 12 ');
    });

    it('is not skipped when the file system gives no birth time', async () => {
      const result = await createLinuxInspector({ procfs: fakeProcfs(entriesFor(0)), layout: LAYOUT, uid: UID, timing: fakeTiming() }).holdersOf('/marker');
      expect(result).toMatchObject({ kind: 'failed', evidence: { kind: 'opaque' } });
    });
  });

  describe('a zombie thread-group leader whose other threads still run', () => {
    const marker = { dev: 1n, ino: 1n };
    const entries: Record<string, FakeEntry> = {
      '/marker': { identity: marker },
      '/proc': { children: ['12'] },
      '/proc/12/fd': { failure: 'EACCES' },
      '/proc/12/stat': { text: STAT_ZOMBIE },
      '/proc/12/task': { children: ['12', '15'] },
      '/proc/12/task/15/fd': { children: ['3'] },
      '/proc/12/task/15/fd/3': { identity: marker },
    };

    it('holds the marker through a live thread', async () => {
      expect(await createLinuxInspector({ procfs: fakeProcfs(entries), layout: LAYOUT, uid: UID }).holdersOf('/marker')).toEqual({ kind: 'value', value: [12] });
    });

    it('holds nothing when every thread is gone', async () => {
      const gone = { ...entries, '/proc/12/task': { children: ['12'] } };
      expect(await createLinuxInspector({ procfs: fakeProcfs(gone), layout: LAYOUT, uid: UID }).holdersOf('/marker')).toEqual({ kind: 'value', value: [] });
    });
  });

  it('reads the owner from the status file, which stays readable while the process is not dumpable', () => {
    expect(parseRealUid(statusOwnedBy(1234).text as string)).toBe(1234);
    expect(() => parseRealUid('Name:\tx\n')).toThrow('no Uid line');
  });

  it('treats a missing marker as gone and classifies other failures', async () => {
    const inspector = createLinuxInspector({ procfs: fakeProcfs({ '/proc': { children: [] }, '/broken': { failure: 'EIO' } }), layout: LAYOUT, uid: UID });
    expect(await inspector.holdersOf('/missing')).toEqual({ kind: 'gone' });
    expect(await inspector.holdersOf('/broken')).toMatchObject({ kind: 'failed', cause: 'transient', evidence: { code: 'EIO' } });
  });

  it('does not hide a failure while reading a descriptor directory', async () => {
    const procfs = fakeProcfs({ '/marker': { identity: { dev: 1n, ino: 1n } }, '/proc': { children: ['10'] }, '/proc/10/fd': { failure: 'EIO' } });
    expect(await createLinuxInspector({ procfs, layout: LAYOUT, uid: UID }).holdersOf('/marker')).toMatchObject({ kind: 'failed', cause: 'transient' });
  });

  it('maps pids to their process group and omits pids that are gone', async () => {
    const inspector = createLinuxInspector({
      procfs: fakeProcfs({ ...BASE_ENTRIES, '/proc/4242/stat': { text: STAT_SLEEP }, '/proc/77/stat': { text: STAT_AWKWARD_COMM } }),
      layout: LAYOUT,
      uid: UID,
    });
    expect(await inspector.groupsOf([4242, 77, 5], [])).toEqual({
      kind: 'value',
      value: new Map([
        [4242, 4242],
        [77, 77],
      ]),
    });
  });
});
