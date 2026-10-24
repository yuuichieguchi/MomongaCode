import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { groupAlive, momongaPaths } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { killGroupsForCleanup, registerCleanup, spawnTracked, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { readDb } from './db.ts';
import { TOOL_GROUPS_SQL, createProcessLedger, formatPidsLine, parsePidsFile } from './ledger.ts';
import type { LedgerPorts } from './ledger.ts';
import { killListedGroups, leftoverEntries } from './teardown.ts';

const DETACHED_GRANDCHILD_SCRIPT = [
  "const child = require('node:child_process').spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });",
  'child.unref();',
  "process.stdout.write(String(child.pid) + '\\n');",
  'setInterval(() => {}, 1000);',
].join(' ');

type FakeWorld = {
  ports: LedgerPorts;
  alive: Map<number, number>;
  groups: Set<number>;
  killed: number[];
  survivors: Set<number>;
};

const fakeWorld = (initial: Record<number, number>): FakeWorld => {
  const alive = new Map<number, number>(Object.entries(initial).map(([pid, start]) => [Number(pid), start]));
  const groups = new Set<number>(alive.keys());
  const killed: number[] = [];
  const survivors = new Set<number>();
  const ports: LedgerPorts = {
    startTimeOf: async (pid) => alive.get(pid),
    groupAlive: (pgid) => groups.has(pgid),
    pidAlive: (pid) => alive.has(pid),
    killGroups: async (pgids) => {
      for (const pgid of pgids) {
        killed.push(pgid);
        if (survivors.has(pgid)) continue;
        groups.delete(pgid);
        alive.delete(pgid);
      }
    },
    findHolders: async () => [],
    pgidOf: async (pid) => (alive.has(pid) ? pid : undefined),
  };
  return { ports, alive, groups, killed, survivors };
};

const healthWith = (pids: readonly number[]): SupervisorHealth => ({
  status: 'ok',
  version: 'e2e',
  apiVersion: 1,
  pid: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  phase: 'running',
  env: 'frozen at supervisor start',
  children: pids.map((pid, index) => ({ role: index === 0 ? 'gateway' : 'runtime', state: 'ready', pid, restarts: 0, consecutiveFailures: 0 })),
  logs: { droppedLines: 0 },
});

const pidsFileIn = (context: CleanupContext): string => path.join(withTempDir(context), 'mme-test-pids');

const firstLine = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const lines = readline.createInterface({ input: stream });
  try {
    for await (const line of lines) return line;
    throw new Error('stream ended before the first line');
  } finally {
    lines.close();
  }
};

const failureOf = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

describe('process ledger: kill', () => {
  it('kills every recorded group one by one, including a detached grandchild the parent group does not contain', async (context) => {
    const parent = spawnTracked(context, process.execPath, ['-e', DETACHED_GRANDCHILD_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = Number(await firstLine(parent.stdout as NodeJS.ReadableStream));
    registerCleanup(context, () => killGroupsForCleanup([grandchild]));
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
    expect(groupAlive(grandchild)).toBe(true);
    const ledger = createProcessLedger({ pidsFile: pidsFileIn(context) });
    await ledger.add(parent.pid, 'fixture');
    await ledger.add(grandchild, 'fixture');
    const killed = await ledger.kill();
    expect([...killed].sort((a, b) => a - b)).toEqual([parent.pid, grandchild].sort((a, b) => a - b));
    expect(groupAlive(parent.pid)).toBe(false);
    expect(groupAlive(grandchild)).toBe(false);
  });

  it('kills the union of recorded and freshly read groups', async (context) => {
    const world = fakeWorld({ 101: 1000, 201: 2000, 202: 2001 });
    const ledger = createProcessLedger({ pidsFile: pidsFileIn(context), ports: world.ports });
    await ledger.add(101, 'supervisor');
    const killed = await ledger.sweep({ health: async () => healthWith([201, 202]) });
    expect([...killed].sort()).toEqual([101, 201, 202]);
    expect([...world.killed].sort()).toEqual([101, 201, 202]);
  });

  it('still kills when the health fetch fails, then rethrows the failure', async (context) => {
    const world = fakeWorld({ 101: 1000, 102: 1001 });
    const ledger = createProcessLedger({ pidsFile: pidsFileIn(context), ports: world.ports });
    await ledger.add(101, 'supervisor');
    await ledger.record(healthWith([102]));
    const failure = await failureOf(
      ledger.sweep({
        health: async () => {
          throw new Error('health exploded');
        },
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('health exploded');
    expect([...world.killed].sort()).toEqual([101, 102]);
  });

  it('treats an unreachable supervisor as no error', async (context) => {
    const world = fakeWorld({ 101: 1000 });
    const ledger = createProcessLedger({ pidsFile: pidsFileIn(context), ports: world.ports });
    await ledger.add(101, 'supervisor');
    for (const code of ['ECONNREFUSED', 'ENOENT']) {
      await expect(
        ledger.sweep({
          health: async () => {
            throw Object.assign(new Error(`connect ${code}`), { code });
          },
        }),
      ).resolves.toBeDefined();
    }
    expect(world.killed).toEqual([101]);
  });

  it('throws naming a group that survives', async (context) => {
    const world = fakeWorld({ 301: 3000 });
    world.survivors.add(301);
    const ledger = createProcessLedger({ pidsFile: pidsFileIn(context), ports: world.ports });
    await ledger.add(301, 'fixture');
    await expect(ledger.kill()).rejects.toThrow(/301/);
  });

  it('never signals a recorded pid whose process now has another start time', async (context) => {
    const world = fakeWorld({ 401: 4000 });
    const ledger = createProcessLedger({ pidsFile: pidsFileIn(context), ports: world.ports });
    await ledger.add(401, 'health');
    world.alive.set(401, 4999);
    const killed = await ledger.kill();
    expect(killed).toEqual([]);
    expect(world.killed).toEqual([]);
  });

  it('kills a group whose leader is gone but whose members live, and drops a group that is dead', async (context) => {
    const world = fakeWorld({ 501: 5000, 502: 5001 });
    const ledger = createProcessLedger({ pidsFile: pidsFileIn(context), ports: world.ports });
    await ledger.add(501, 'db');
    await ledger.add(502, 'db');
    world.alive.delete(501);
    world.groups.delete(502);
    world.alive.delete(502);
    const killed = await ledger.kill();
    expect(killed).toEqual([501]);
    expect(world.killed).toEqual([501]);
    expect(ledger.entries().map((entry) => entry.pgid)).not.toContain(502);
  });
});

describe('process ledger: persistence', () => {
  it('appends one line per new group and none for a repeat', async (context) => {
    const world = fakeWorld({ 101: 1000, 102: 1001 });
    const pidsFile = pidsFileIn(context);
    const ledger = createProcessLedger({ pidsFile, ports: world.ports });
    await ledger.add(101, 'supervisor');
    await ledger.add(101, 'health');
    await ledger.add(102, 'fixture');
    const text = fs.readFileSync(pidsFile, 'utf8');
    expect(text.split('\n').filter((line) => line !== '')).toHaveLength(2);
    expect(parsePidsFile(text)).toEqual([
      { pgid: 101, startTime: 1000, source: 'supervisor' },
      { pgid: 102, startTime: 1001, source: 'fixture' },
    ]);
    expect(fs.statSync(pidsFile).mode & 0o777).toBe(0o600);
    expect(ledger.pidsFile).toBe(pidsFile);
  });

  it('formats a line that parses back to the same entry', () => {
    const entry = { pgid: 77, startTime: undefined, source: 'marker-holder' } as const;
    expect(formatPidsLine(entry).endsWith('\n')).toBe(true);
    expect(parsePidsFile(formatPidsLine(entry))).toEqual([entry]);
  });
});

describe('process ledger: sources', () => {
  it('collects from health, the supervisor logs, the database, the record files and the marker holders', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    fs.mkdirSync(path.dirname(paths.logFiles.supervisor), { recursive: true, mode: 0o700 });
    const logLine = (msg: string, childPid: number | null): string =>
      `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', level: 'info', service: 'supervisor', pid: 1, msg, child: 'runtime', childPid })}\n`;
    fs.writeFileSync(`${paths.logFiles.supervisor}.1`, logLine('child.spawn', 601));
    fs.writeFileSync(paths.logFiles.supervisor, `${logLine('child.ready', 602)}${logLine('child.spawn', null)}`);
    fs.mkdirSync(path.dirname(paths.databases.runtime), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(paths.databases.runtime);
    db.exec('CREATE TABLE idempotency (key TEXT, pgid INTEGER)');
    db.exec("INSERT INTO idempotency VALUES ('a', 701), ('b', NULL)");
    db.close();
    const recordFile = path.join(home, 'mcp.rec');
    const readyFile = path.join(home, 'gc.ready');
    fs.writeFileSync(recordFile, `${JSON.stringify({ type: 'ready', pid: 801 })}\n${JSON.stringify({ type: 'list', cursor: null })}\n${JSON.stringify({ type: 'grandchild', pid: 802 })}\n`);
    fs.writeFileSync(readyFile, '803');
    fs.mkdirSync(paths.markers.tools, { recursive: true, mode: 0o700 });
    const marker = path.join(paths.markers.tools, 'tool-marker');
    fs.writeFileSync(marker, '');
    const world = fakeWorld({ 401: 1, 601: 1, 602: 1, 701: 1, 801: 1, 802: 1, 803: 1, 901: 1, 990: 1 });
    const ports: LedgerPorts = {
      ...world.ports,
      findHolders: async (file) => (fs.realpathSync(file) === fs.realpathSync(marker) ? [901] : []),
      pgidOf: async (pid) => (pid === 901 ? 990 : pid),
    };
    const ledger = createProcessLedger({ pidsFile: pidsFileIn(context), ports });
    await ledger.collect({ health: async () => healthWith([401]), paths, recordFiles: [recordFile, readyFile] });
    const bySource = Object.fromEntries(ledger.entries().map((entry) => [entry.pgid, entry.source]));
    expect(bySource).toEqual({
      401: 'health',
      601: 'supervisor-log',
      602: 'supervisor-log',
      701: 'db',
      801: 'mcp-record',
      802: 'mcp-record',
      803: 'mcp-record',
      990: 'marker-holder',
    });
  });

  it('collects nothing and throws nothing when no source exists yet', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const world = fakeWorld({});
    const ledger = createProcessLedger({ pidsFile: pidsFileIn(context), ports: world.ports });
    await expect(ledger.collect({ paths: momongaPaths(home), recordFiles: [path.join(home, 'mcp.rec'), path.join(home, 'gc.ready')] })).resolves.toBeUndefined();
    expect(ledger.entries()).toEqual([]);
  });
});

const persistedIn = (pidsFile: string) => (fs.existsSync(pidsFile) ? parsePidsFile(fs.readFileSync(pidsFile, 'utf8')) : []);

type SourceFixture = { paths: ReturnType<typeof momongaPaths>; recordFile: string; marker: string };

const sourceFixture = (context: CleanupContext): SourceFixture => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  fs.mkdirSync(path.dirname(paths.logFiles.supervisor), { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.markers.tools, { recursive: true, mode: 0o700 });
  const marker = path.join(paths.markers.tools, 'tool-marker');
  fs.writeFileSync(marker, '');
  return { paths, recordFile: path.join(home, 'mcp.rec'), marker };
};

const holderPorts = (world: FakeWorld, marker: string, holder: number, pgid: number): LedgerPorts => ({
  ...world.ports,
  findHolders: async (file) => (fs.realpathSync(file) === fs.realpathSync(marker) ? [holder] : []),
  pgidOf: async (pid) => (pid === holder ? pgid : pid),
});

const writeToolGroupRow = (databaseFile: string, pgid: number): void => {
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databaseFile);
  db.exec('CREATE TABLE idempotency (key TEXT, pgid INTEGER)');
  db.prepare('INSERT INTO idempotency VALUES (?, ?)').run('a', pgid);
  db.close();
};

describe('process ledger: isolated sources', () => {
  it('still collects, persists and kills a marker holder when the supervisor log source throws, then sweep rethrows', async (context) => {
    const fixture = sourceFixture(context);
    fs.writeFileSync(fixture.paths.logFiles.supervisor, 'not json\n');
    const world = fakeWorld({ 990: 1 });
    const pidsFile = pidsFileIn(context);
    const ledger = createProcessLedger({ pidsFile, ports: holderPorts(world, fixture.marker, 901, 990) });
    const failure = await failureOf(ledger.sweep({ paths: fixture.paths }));
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('not JSON');
    expect(persistedIn(pidsFile)).toEqual([{ pgid: 990, startTime: 1, source: 'marker-holder' }]);
    expect(world.killed).toEqual([990]);
  });

  it('runs every source and throws the failures of two sources together as an AggregateError', async (context) => {
    const fixture = sourceFixture(context);
    fs.writeFileSync(fixture.paths.logFiles.supervisor, 'not json\n');
    fs.writeFileSync(fixture.recordFile, 'not a record\n');
    writeToolGroupRow(fixture.paths.databases.runtime, 701);
    const world = fakeWorld({ 701: 7, 990: 9 });
    const ledger = createProcessLedger({ pidsFile: pidsFileIn(context), ports: holderPorts(world, fixture.marker, 901, 990) });
    const failure = await failureOf(ledger.collect({ paths: fixture.paths, recordFiles: [fixture.recordFile] }));
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(Object.fromEntries(ledger.entries().map((entry) => [entry.pgid, entry.source]))).toEqual({ 701: 'db', 990: 'marker-holder' });
  });
});

const recordingHolderPorts = (world: FakeWorld, marker: string, holder: number, pgid: number): { ports: LedgerPorts; holderQueries: string[] } => {
  const holderQueries: string[] = [];
  const base = holderPorts(world, marker, holder, pgid);
  return {
    holderQueries,
    ports: {
      ...base,
      findHolders: async (file) => {
        holderQueries.push(file);
        return base.findHolders(file);
      },
    },
  };
};

describe('process ledger: current persisted file', () => {
  it('a health reading persists a group seen only in the DB and never scans the marker holders', async (context) => {
    const fixture = sourceFixture(context);
    writeToolGroupRow(fixture.paths.databases.runtime, 701);
    const world = fakeWorld({ 401: 4, 701: 7, 990: 9 });
    const pidsFile = pidsFileIn(context);
    const { ports, holderQueries } = recordingHolderPorts(world, fixture.marker, 901, 990);
    const ledger = createProcessLedger({ pidsFile, ports, sources: { paths: fixture.paths, recordFiles: [fixture.recordFile] } });
    await ledger.record(healthWith([401]));
    expect(Object.fromEntries(persistedIn(pidsFile).map((entry) => [entry.pgid, entry.source]))).toEqual({ 401: 'health', 701: 'db' });
    expect(holderQueries).toEqual([]);
    expect(world.killed).toEqual([]);
  });

  it('the sweep after health readings still scans the marker holders and kills a group visible only through a marker', async (context) => {
    const fixture = sourceFixture(context);
    const world = fakeWorld({ 401: 4, 990: 9 });
    const pidsFile = pidsFileIn(context);
    const { ports, holderQueries } = recordingHolderPorts(world, fixture.marker, 901, 990);
    const ledger = createProcessLedger({ pidsFile, ports, sources: { paths: fixture.paths, recordFiles: [fixture.recordFile] } });
    await ledger.record(healthWith([401]));
    const killed = await ledger.sweep({ health: async () => healthWith([]) });
    expect(holderQueries.length).toBeGreaterThan(0);
    expect([...killed].sort()).toEqual([401, 990]);
    expect(Object.fromEntries(persistedIn(pidsFile).map((entry) => [entry.pgid, entry.source]))).toEqual({ 401: 'health', 990: 'marker-holder' });
  });

  it('a health reading resolves and records its children and the other sources when one per-poll source throws', async (context) => {
    const fixture = sourceFixture(context);
    fs.writeFileSync(fixture.paths.logFiles.supervisor, 'not json\n');
    writeToolGroupRow(fixture.paths.databases.runtime, 701);
    const world = fakeWorld({ 401: 4, 701: 7 });
    const pidsFile = pidsFileIn(context);
    const ledger = createProcessLedger({
      pidsFile,
      ports: world.ports,
      sources: { paths: fixture.paths, recordFiles: [fixture.recordFile] },
    });
    await expect(ledger.record(healthWith([401]))).resolves.toBeUndefined();
    expect(Object.fromEntries(persistedIn(pidsFile).map((entry) => [entry.pgid, entry.source]))).toEqual({ 401: 'health', 701: 'db' });
  });

  it('retains a per-poll failure and the later sweep kills, then rethrows it together with its own failure', async (context) => {
    const fixture = sourceFixture(context);
    fs.writeFileSync(fixture.recordFile, 'not a record\n');
    const world = fakeWorld({ 401: 4 });
    const ledger = createProcessLedger({
      pidsFile: pidsFileIn(context),
      ports: world.ports,
      sources: { paths: fixture.paths, recordFiles: [fixture.recordFile] },
    });
    await expect(ledger.record(healthWith([401]))).resolves.toBeUndefined();
    fs.rmSync(fixture.recordFile);
    const failure = await failureOf(
      ledger.sweep({
        health: async () => {
          throw new Error('health exploded');
        },
      }),
    );
    expect(failure).toBeInstanceOf(AggregateError);
    const messages = (failure as AggregateError).errors.map((error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(messages).toHaveLength(2);
    expect(messages).toContain('health exploded');
    expect(messages.some((message: string) => message.includes('JSON'))).toBe(true);
    expect(world.killed).toEqual([401]);
  });

  it('a sweep given only health still collects from the configured sources and kills a record-file pid', async (context) => {
    const fixture = sourceFixture(context);
    fs.writeFileSync(fixture.recordFile, `${JSON.stringify({ type: 'ready', pid: 801 })}\n`);
    const world = fakeWorld({ 801: 8 });
    const ledger = createProcessLedger({
      pidsFile: pidsFileIn(context),
      ports: world.ports,
      sources: { paths: fixture.paths, recordFiles: [fixture.recordFile] },
    });
    const killed = await ledger.sweep({ health: async () => healthWith([]) });
    expect(killed).toEqual([801]);
    expect(world.killed).toEqual([801]);
  });
});

describe('tolerant readers', () => {
  it('readDb returns no rows for a database that does not exist', (context) => {
    const dir = withTempDir(context);
    expect(readDb(path.join(dir, 'missing.db'), TOOL_GROUPS_SQL)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'missing.db'))).toBe(false);
  });

  it('readDb reads rows read-only', (context) => {
    const file = path.join(withTempDir(context), 'runs.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE idempotency (key TEXT, pgid INTEGER)');
    db.exec("INSERT INTO idempotency VALUES ('a', 42), ('b', NULL)");
    db.close();
    expect(readDb<{ pgid: number }>(file, TOOL_GROUPS_SQL)).toEqual([{ pgid: 42 }]);
  });
});

describe('teardown helpers', () => {
  it('leftoverEntries reports the roots of this run and testkit dirs, never the harness files or other runs', () => {
    const listing = ['mme-ab12-pids', 'mme-ab12-live', 'mme-ab12-x1Y2z3', 'mme-cd34-aaaaaa', 'mmt-ab12-QqQqQq', 'mmt-x-zzzzzz', 'mm-abcdef', 'mme-ab12-a0b1c2'];
    expect([...leftoverEntries(listing, 'ab12')].sort()).toEqual(['mme-ab12-a0b1c2', 'mme-ab12-x1Y2z3', 'mmt-ab12-QqQqQq']);
    expect(leftoverEntries(['mme-ab12-pids', 'mme-ab12-live'], 'ab12')).toEqual([]);
  });

  it('killListedGroups kills the live listed groups with a matching start time and skips a reused pid', async (context) => {
    const pidsFile = pidsFileIn(context);
    fs.writeFileSync(
      pidsFile,
      [
        formatPidsLine({ pgid: 101, startTime: 1000, source: 'supervisor' }),
        formatPidsLine({ pgid: 102, startTime: 1001, source: 'health' }),
        formatPidsLine({ pgid: 103, startTime: 1002, source: 'db' }),
      ].join(''),
    );
    const world = fakeWorld({ 101: 1000, 102: 9999 });
    const killed = await killListedGroups(pidsFile, world.ports);
    expect(killed).toEqual([101]);
    expect(world.killed).toEqual([101]);
  });

  it('killListedGroups kills nothing when the ledger file does not exist', async (context) => {
    const world = fakeWorld({ 101: 1000 });
    await expect(killListedGroups(path.join(withTempDir(context), 'mme-none-pids'), world.ports)).resolves.toEqual([]);
    expect(world.killed).toEqual([]);
  });
});
