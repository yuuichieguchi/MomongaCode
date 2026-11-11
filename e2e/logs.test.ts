import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChildRole } from '@momonga/supervisor';
import { titleOf } from './support/cases.ts';
import { NOISY_JSON_MSG, NOISY_STDERR_LINES, NOISY_STDOUT_LINE } from './support/fixtures/noisy-daemon.ts';
import { createE2eHome, registerE2eCleanup } from './support/home.ts';
import { readLog, supervisorLog } from './support/log-reader.ts';
import type { LogRecord } from './support/log-reader.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import { DEFAULT_E2E_DEPS, shutdownBarrier, startStack } from './support/stack.ts';
import { childOf, pidOf } from './support/supervisor-client.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS } from './support/wait.ts';
import { firstGeneration } from '@momonga/testkit';

const NOISY_DAEMON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'support', 'fixtures', 'noisy-daemon.ts');
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RAW_TEXTS = [...NOISY_STDERR_LINES, NOISY_STDOUT_LINE, NOISY_JSON_MSG];

const named = (records: readonly LogRecord[], msg: string): LogRecord[] => records.filter((record) => record.msg === msg);

const ofChild = (records: readonly LogRecord[], msg: string, role: ChildRole): LogRecord[] => named(records, msg).filter((record) => record.child === role);

const fileMode = (file: string): number => fs.statSync(file).mode & 0o777;

const expectRequiredFields = (records: readonly LogRecord[]): void => {
  for (const record of records) {
    expect(record.ts).toMatch(ISO_TIMESTAMP);
    expect(LOG_LEVELS).toContain(record.level);
    expect(typeof record.service).toBe('string');
    expect(Number.isInteger(record.pid)).toBe(true);
    expect(record.pid).toBeGreaterThan(0);
    expect(typeof record.msg).toBe('string');
    expect(record.msg).not.toBe('');
  }
};

const daemonRecordOnPipe = (record: LogRecord): boolean => {
  if (typeof record.raw !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(record.raw);
    return typeof parsed === 'object' && parsed !== null && (parsed as { service?: unknown }).service === record.child;
  } catch {
    return false;
  }
};

describe('logs', () => {
  it(titleOf('logs-layout'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home });
    const runtime = createRuntimeClient(home);
    registerE2eCleanup(() => runtime.close());
    const { session } = await runtime.createSession();
    const { run } = await runtime.createRun(session.id, 'Say hello');
    const stream = runtime.events(run.id);
    registerE2eCleanup(() => stream.close());
    const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
    expect(frames.at(-1)?.data).toMatchObject({ type: 'run.status', to: 'COMPLETED' });

    const health = await stack.client.health();
    const runtimePid = pidOf(health, 'runtime');
    const gatewayPid = pidOf(health, 'gateway');
    const ledgerPgids = new Set(home.ledger.entries().map((entry) => entry.pgid));
    const { logFiles } = home.paths;

    for (const file of [logFiles.supervisor, logFiles.gateway, logFiles.runtime]) {
      expect(fs.existsSync(file)).toBe(true);
      expect(fileMode(file)).toBe(0o600);
    }
    const supervisorRecords = readLog(logFiles.supervisor);
    const gatewayRecords = readLog(logFiles.gateway);
    const runtimeRecords = readLog(logFiles.runtime);
    for (const records of [supervisorRecords, gatewayRecords, runtimeRecords]) {
      expect(records.length).toBeGreaterThan(0);
      expectRequiredFields(records);
    }
    const lineCount = (file: string): number => fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').length;
    expect(lineCount(logFiles.supervisor)).toBe(supervisorRecords.length);
    expect(lineCount(logFiles.gateway)).toBe(gatewayRecords.length);
    expect(lineCount(logFiles.runtime)).toBe(runtimeRecords.length);

    for (const record of gatewayRecords) {
      expect(record.service).toBe('gateway');
      expect(ledgerPgids.has(record.pid)).toBe(true);
    }
    for (const record of runtimeRecords) {
      expect(record.service).toBe('runtime');
      expect(ledgerPgids.has(record.pid)).toBe(true);
    }
    expect(new Set(gatewayRecords.map((record) => record.pid))).toEqual(new Set([gatewayPid]));
    expect(new Set(runtimeRecords.map((record) => record.pid))).toEqual(new Set([runtimePid]));
    expect(named(runtimeRecords, 'runtime ready')).toEqual([expect.objectContaining({ pid: runtimePid, service: 'runtime' })]);
    expect(named(runtimeRecords, 'entry.start')).toEqual([expect.objectContaining({ pid: runtimePid, logTarget: 'file', lifeline: true })]);
    expect(named(gatewayRecords, 'entry.start')).toEqual([expect.objectContaining({ pid: gatewayPid, logTarget: 'file', lifeline: true })]);

    for (const record of supervisorRecords) {
      expect(record.service).toBe('supervisor');
      expect(record.pid).toBe(stack.ready.pid);
    }
    const scoped = supervisorLog(home.paths, stack.ready.pid);
    expect(scoped).toEqual(supervisorRecords);
    for (const [role, pid] of [['runtime', runtimePid], ['gateway', gatewayPid]] as const) {
      expect(ofChild(scoped, 'child.spawn', role)).toEqual([expect.objectContaining({ childPid: pid, reason: 'initial', restarts: 0 })]);
      expect(ofChild(scoped, 'child.ready', role)).toEqual([expect.objectContaining({ childPid: pid, socketPath: firstGeneration(home.paths).sockets[role] })]);
    }
    expect(scoped.filter((record) => record.service === 'runtime' || record.service === 'gateway')).toEqual([]);
    expect([...gatewayRecords, ...runtimeRecords].filter((record) => record.service === 'supervisor')).toEqual([]);
    expect(named(scoped, 'child.stderr').filter(daemonRecordOnPipe)).toEqual([]);
    expect(named(scoped, 'child.stdout')).toEqual([]);
    expect([...gatewayRecords, ...runtimeRecords].filter((record) => record.msg === 'child.stderr' || record.msg === 'child.stdout')).toEqual([]);
  });

  it(titleOf('logs-raw-output'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({
      home,
      deps: { ...DEFAULT_E2E_DEPS, launcherOverrides: { gateway: { script: NOISY_DAEMON_PATH, args: ['--role=gateway'] } } },
    });
    const health = await stack.client.health();
    const fixturePid = pidOf(health, 'gateway');
    expect(childOf(health, 'gateway')).toMatchObject({ state: 'ready', pid: fixturePid, restarts: 0, consecutiveFailures: 0 });
    expect(childOf(health, 'runtime')).toMatchObject({ state: 'ready', restarts: 0 });

    await shutdownBarrier(stack);
    const records = supervisorLog(home.paths, stack.ready.pid);
    const raw = { records, stderr: ofChild(records, 'child.stderr', 'gateway'), stdout: ofChild(records, 'child.stdout', 'gateway') };

    expect(raw.stderr.map((record) => record.raw)).toEqual([...NOISY_STDERR_LINES]);
    for (const record of raw.stderr) {
      expect(record).toMatchObject({ level: 'warn', service: 'supervisor', pid: stack.ready.pid, child: 'gateway', childPid: fixturePid });
      expect(record.rawBytes).toBe(Buffer.byteLength(String(record.raw)));
      expect(record.truncated).toBeUndefined();
    }
    expect(raw.stdout).toEqual([
      expect.objectContaining({ level: 'info', service: 'supervisor', child: 'gateway', childPid: fixturePid, raw: NOISY_STDOUT_LINE, rawBytes: Buffer.byteLength(NOISY_STDOUT_LINE) }),
    ]);
    expect(named(raw.records, NOISY_JSON_MSG)).toEqual([]);
    expect(readLog(home.paths.logFiles.supervisor).filter((record) => record.msg === NOISY_JSON_MSG)).toEqual([]);
    expect(ofChild(raw.records, 'child.ready', 'gateway')).toEqual([expect.objectContaining({ childPid: fixturePid })]);
    expect(named(raw.records, 'child.ready.mismatch')).toEqual([]);
    expect(ofChild(raw.records, 'child.stderr', 'runtime').filter(daemonRecordOnPipe)).toEqual([]);

    for (const file of [home.paths.logFiles.gateway, home.paths.logFiles.runtime]) {
      for (const record of readLog(file)) {
        expect(record.msg).not.toBe('child.stderr');
        expect(record.msg).not.toBe('child.stdout');
        const line = JSON.stringify(record);
        for (const text of RAW_TEXTS) expect(line.includes(text)).toBe(false);
      }
    }
    const gatewayLogText = fs.existsSync(home.paths.logFiles.gateway) ? fs.readFileSync(home.paths.logFiles.gateway, 'utf8') : '';
    for (const text of RAW_TEXTS) expect(gatewayLogText.includes(text)).toBe(false);
    expect(fs.readFileSync(home.paths.logFiles.runtime, 'utf8').includes(NOISY_STDOUT_LINE)).toBe(false);

  });
});
