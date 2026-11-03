import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOG_KEEP, LOG_MAX_BYTES, createJsonLogger, createRotatingLogFile, momongaPaths, systemClock } from '@momonga/foundation';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, registerCleanup, withTempDir } from '@momonga/testkit';
import type { JsonLine } from '@momonga/testkit';
import { startSupervisor } from '../src/start-supervisor.ts';
import { OVERLONG_STDERR_BYTES, OWN_LOG_MSG, RAW_STDERR_LINES, STRAY_STDOUT_LINE } from './fixtures/p3b-engine-child.ts';
import { validSettings, writeSettings } from './fixtures/p3-harness.ts';
import { pollUntil } from './support/p2-poll.ts';
import { trackedSpawnPort } from './support/tracked-spawn-port.ts';

const ENGINE_CHILD = fileURLToPath(new URL('./fixtures/p3b-engine-child.ts', import.meta.url));
const RAW_TRUNCATE_BYTES = 8 * 1024;
const ROLES = ['gateway', 'runtime'] as const;

const readLines = (file: string): JsonLine[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .slice(0, -1)
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as JsonLine)
    : [];

describe('supervisor.log and role logs with real children', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('real child end-to-end', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, {});
    writeSettings(home, validSettings());
    const sink = createRotatingLogFile({ path: paths.logFiles.supervisor, maxBytes: LOG_MAX_BYTES, keep: LOG_KEEP, mode: 0o600 });
    registerCleanup(context, () => sink.close());
    const logger = createJsonLogger({ service: 'supervisor', clock: systemClock, stream: { write: (chunk) => (sink.write(chunk), true) } });
    const port = trackedSpawnPort(context);
    const supervisor = await startSupervisor({
      home,
      version: '0.0.0-e2e',
      launcher: (role) => ({ command: process.execPath, args: [ENGINE_CHILD, `--role=${role}`] }),
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home },
      spawn: port,
      logger,
      stdout: { write: () => true },
      watchSettings: false,
      startupTimeoutMs: 20_000,
      orphanReapGraceMs: 200,
    });
    registerCleanup(context, async () => {
      await supervisor.abort();
    });

    const supervisorLines = (): JsonLine[] => readLines(paths.logFiles.supervisor);
    const wrapped = (msg: string, role: string): JsonLine[] => supervisorLines().filter((line) => line.msg === msg && line['child'] === role);
    await pollUntil(
      () => ROLES.every((role) => wrapped('child.stdout', role).length === 1 && wrapped('child.stderr', role).length === RAW_STDERR_LINES.length),
      20_000,
      'raw output of both children captured',
    );

    for (const role of ROLES) {
      const spawn = supervisorLines().find((line) => line.msg === 'child.spawn' && line['child'] === role);
      const childPid = spawn?.['childPid'];
      expect(typeof childPid).toBe('number');
      expect(port.spawned.map((handle) => handle.pid)).toContain(childPid);

      const stderrRecords = wrapped('child.stderr', role);
      expect(stderrRecords.map((line) => line['raw'])).toEqual([...RAW_STDERR_LINES.slice(0, -1), 'x'.repeat(RAW_TRUNCATE_BYTES)]);
      for (const [index, record] of stderrRecords.entries()) {
        expect(record).toMatchObject({ level: 'warn', service: 'supervisor', pid: process.pid, msg: 'child.stderr', child: role, childPid });
        expect(record['rawBytes']).toBe(Buffer.byteLength(RAW_STDERR_LINES[index] as string));
      }
      expect(stderrRecords.slice(0, -1).every((record) => !('truncated' in record))).toBe(true);
      expect(stderrRecords.at(-1)).toMatchObject({ rawBytes: OVERLONG_STDERR_BYTES, truncated: true });

      expect(wrapped('child.stdout', role)).toEqual([
        expect.objectContaining({ level: 'info', service: 'supervisor', pid: process.pid, msg: 'child.stdout', child: role, childPid, raw: STRAY_STDOUT_LINE, rawBytes: Buffer.byteLength(STRAY_STDOUT_LINE) }),
      ]);
      expect(wrapped('child.ready', role)).toEqual([expect.objectContaining({ childPid, version: '0.0.0-e2e', socketPath: paths.sockets[role] })]);
      expect(supervisorLines().filter((line) => line['child'] === role && String(line['raw'] ?? '').includes(OWN_LOG_MSG))).toEqual([]);
      expect(supervisorLines().filter((line) => line['child'] === role && String(line['raw'] ?? '').includes('"event":"ready"'))).toEqual([]);

      const roleLines = readLines(paths.logFiles[role]);
      expect(roleLines.map((line) => line.msg)).toEqual(expect.arrayContaining(['entry.start', OWN_LOG_MSG]));
      for (const line of roleLines) {
        expect(line).toMatchObject({ service: role, pid: childPid });
        expect(line).not.toHaveProperty('raw');
        expect(['child.stderr', 'child.stdout']).not.toContain(line.msg);
      }
      expect(fs.readFileSync(paths.logFiles[role], 'utf8')).not.toContain('plain stderr text');
    }

    const result = await supervisor.close();
    expect(result).toMatchObject({ clean: true, leaked: [] });
  });
});
