import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createUdsClient, momongaPaths } from '@momonga/foundation';
import { readJsonLinesFile, registerCleanup, startDaemonBin, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import packageJson from '../../package.json' with { type: 'json' };
import { writeUserSettings } from './helpers.ts';
import { MINIMAL_PATH, modelSettings } from './run-helpers.ts';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/bin.ts');
const PROCESS_TIMEOUT = { timeout: 90_000 };

const prepare = (context: CleanupContext) => {
  const home = withTempDir(context, { asHome: true });
  const aux = withTempDir(context);
  writeUserSettings(home, { sandbox: 'none', ...modelSettings(path.join(aux, 'up.sock')) });
  return { home, paths: momongaPaths(home, 'darwin', {}), env: { PATH: MINIMAL_PATH, HOME: home, TMPDIR: aux } };
};

const msgs = (lines: ReadonlyArray<Record<string, unknown>>): unknown[] => lines.map((line) => line['msg']);

describe('runtime bin (real process, §5.3)', () => {
  it('bin smoke: one ready line on stdout, SIGTERM exits 0, JSON stderr, runtime.log 0600 ending with entry.exit', PROCESS_TIMEOUT, async (context) => {
    const { home, paths, env } = prepare(context);
    const daemon = startDaemonBin(context, BIN, [`--home=${home}`], env);

    const ready = JSON.parse(await daemon.waitForReady()) as Record<string, unknown>;
    expect(ready).toMatchObject({ event: 'ready', service: 'runtime', version: packageJson.version, pid: daemon.child.pid, socketPath: paths.sockets.runtime });
    daemon.child.kill('SIGTERM');

    expect(await daemon.waitForExit()).toBe(0);
    expect(daemon.stdoutLines()).toHaveLength(1);
    for (const line of daemon.stderrLines()) expect(() => JSON.parse(line)).not.toThrow();
    expect(fs.statSync(paths.logFiles.runtime).mode & 0o777).toBe(0o600);
    const log = readJsonLinesFile(paths.logFiles.runtime);
    expect(log.at(-1)).toMatchObject({ msg: 'entry.exit', service: 'runtime', pid: daemon.child.pid, code: 0, path: 'close', clean: true, trigger: 'sigterm' });
  });

  it('entry writes its role log by default and echoes the same lines to stderr', PROCESS_TIMEOUT, async (context) => {
    const { home, paths, env } = prepare(context);
    const daemon = startDaemonBin(context, BIN, [`--home=${home}`], env);
    await daemon.waitForReady();
    daemon.child.kill('SIGTERM');
    expect(await daemon.waitForExit()).toBe(0);

    const log = readJsonLinesFile(paths.logFiles.runtime);
    expect(log[0]).toMatchObject({ msg: 'entry.start', service: 'runtime', logTarget: 'both' });
    expect(log.at(-1)).toMatchObject({ msg: 'entry.exit' });
    const echoed = daemon.stderrLines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(msgs(echoed)).toEqual(msgs(log));
  });

  it('--log-target=file writes nothing to stderr and the role log holds every line', PROCESS_TIMEOUT, async (context) => {
    const { home, paths, env } = prepare(context);
    const daemon = startDaemonBin(context, BIN, [`--home=${home}`, '--log-target=file'], env);
    await daemon.waitForReady();
    daemon.child.kill('SIGTERM');
    expect(await daemon.waitForExit()).toBe(0);

    expect(daemon.stderrLines()).toEqual([]);
    const log = readJsonLinesFile(paths.logFiles.runtime);
    expect(log[0]).toMatchObject({ msg: 'entry.start', logTarget: 'file' });
    expect(log.at(-1)).toMatchObject({ msg: 'entry.exit', code: 0, path: 'close', clean: true, trigger: 'sigterm' });
  });

  it('bin without supervisor does not exit on its own: it serves /v1/health and is still running', PROCESS_TIMEOUT, async (context) => {
    const { home, paths, env } = prepare(context);
    const daemon = startDaemonBin(context, BIN, [`--home=${home}`, '--log-target=file'], env);
    await daemon.waitForReady();
    const client = createUdsClient(paths.sockets.runtime);
    registerCleanup(context, () => client.close());

    const response = await client.request({ method: 'GET', path: '/v1/health' });

    expect(response.status).toBe(200);
    expect(daemon.child.exitCode).toBeNull();
    expect(daemon.child.signalCode).toBeNull();
    daemon.child.kill('SIGTERM');
    expect(await daemon.waitForExit()).toBe(0);
  });
});
