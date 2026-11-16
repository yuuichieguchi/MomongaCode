import { prepareHome } from './gateway-process-helpers.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, createUdsClient, momongaPaths, fixedSocket, parseProgressLine } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, productTestEnv, readJsonLinesFile, registerCleanup, startDaemonBin, withTempDir, firstGeneration } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import packageJson from '../package.json' with { type: 'json' };
import { MINIMAL_PATH, ccTarget, writeSettings, modelsOf } from './gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/bin.ts');
const prepare = (context: CleanupContext) => {
  const home = withTempDir(context, { asHome: true });
  prepareHome(home);
  const aux = withTempDir(context);
  writeSettings(home, { models: modelsOf({ primary: ccTarget(path.join(aux, 'up.sock')) }) });
  return { home, paths: momongaPaths(home, process.platform, {}), env: productTestEnv({ PATH: MINIMAL_PATH, HOME: home, TMPDIR: aux }) };
};

describe('gateway bin (real process, §5.3)', () => {
  it('bin smoke: one ready line on stdout, SIGTERM exits 0, JSON stderr, gateway.log 0600 ending with entry.exit', async (context) => {
    const { home, paths, env } = prepare(context);
    const daemon = startDaemonBin(context, BIN, [`--home=${home}`, `--generation=${FIRST_GENERATION}`], env);

    const ready = JSON.parse(await daemon.waitForReady()) as Record<string, unknown>;
    expect(ready).toMatchObject({ event: 'ready', service: 'gateway', version: packageJson.version, pid: daemon.child.pid, socketPath: firstGeneration(paths).sockets.gateway });
    daemon.child.kill('SIGTERM');

    expect(await daemon.waitForExit()).toBe(0);
    expect(daemon.stdoutLines().filter((line) => parseProgressLine(line) === undefined)).toHaveLength(1);
    for (const line of daemon.stderrLines()) expect(() => JSON.parse(line)).not.toThrow();
    expect(fs.statSync(paths.logFiles.gateway).mode & 0o777).toBe(0o600);
    const log = readJsonLinesFile(paths.logFiles.gateway);
    expect(log[0]).toMatchObject({ msg: 'entry.start', service: 'gateway' });
    expect(log.at(-1)).toMatchObject({ msg: 'entry.exit', service: 'gateway', pid: daemon.child.pid, code: 0, path: 'close', clean: true, trigger: 'sigterm' });
  });

  it('--log-target=file writes nothing to stderr and the gateway serves health until signalled', async (context) => {
    const { home, paths, env } = prepare(context);
    const daemon = startDaemonBin(context, BIN, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=file'], env);
    await daemon.waitForReady();
    const client = createUdsClient(fixedSocket(firstGeneration(paths).sockets.gateway), { connectTimeoutMs: 0 });
    registerCleanup(context, () => client.close());

    const response = await client.request({ method: 'GET', path: '/v1/momonga/health' });

    expect(response.status).toBe(200);
    expect(daemon.child.exitCode).toBeNull();
    daemon.child.kill('SIGTERM');
    expect(await daemon.waitForExit()).toBe(0);
    expect(daemon.stderrLines()).toEqual([]);
    expect(readJsonLinesFile(paths.logFiles.gateway).at(-1)).toMatchObject({ msg: 'entry.exit', code: 0, path: 'close', clean: true, trigger: 'sigterm' });
  });
});
