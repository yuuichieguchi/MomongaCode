import { request } from 'undici';
import { describe, expect, it, vi } from 'vitest';
import { createJsonLogger, systemClock, FIRST_GENERATION } from '@momonga/foundation';
import { startGatewayProcess, systemProcessFiles } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, registerCleanup, withTempDir, registerOwned, testLocks } from '@momonga/testkit';
import { PROCESS_VERSION, baseEnv, ccTarget, writeSettings, modelsOf, prepareHome } from './gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const TOKEN = 'injected-debug-token';

describe('gateway process ports', () => {
  it('reads the debug token and the database presence through the injected file ports', async (context) => {
    const home = withTempDir(context, { asHome: true });
    prepareHome(home);
    writeSettings(home, { models: modelsOf({ primary: ccTarget('/nonexistent/upstream.sock') }) });
    const lines: string[] = [];
    const asked: string[] = [];
    const handle = await registerOwned(context, () => startGatewayProcess({
      locks: testLocks(),
      generation: FIRST_GENERATION,
      home,
      env: baseEnv(home),
      version: PROCESS_VERSION,
      debugTcp: { port: 0, tokenFile: '/nonexistent/debug.token' },
      files: {
        isUsableBinary: async () => false,
        paths: systemProcessFiles.paths,
        readDebugToken: (file) => {
          asked.push(file);
          return TOKEN;
        },
        databaseExists: () => false,
        readTextFile: async (file) => {
          throw new Error(`no CA file is configured in this test, yet ${file} was read`);
        },
      },
      random: () => 0.25,
      logger: createJsonLogger({ service: 'gateway', clock: systemClock, stream: { write: (chunk: string) => (lines.push(chunk), true) }, level: 'debug' }),
      stdout: { write: () => true },
    }));
    registerCleanup(context, async () => {
      await handle.close();
    });
    expect(asked).toEqual(['/nonexistent/debug.token']);
    const listener = lines.map((line) => JSON.parse(line) as Record<string, any>).find((line) => line['msg'] === 'gateway.debug_listener');
    const port = listener?.['data']?.port ?? listener?.['port'];
    const response = await request(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.statusCode).toBe(200);
    await response.body.dump();
  });
});
