import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelSettings, standInEnv, startFakeChatCompletions } from '@momonga/testkit';
import { titleOf } from './support/cases.ts';
import { createE2eHome, registerE2eCleanup } from './support/home.ts';
import { SUPERVISOR_APP_VERSION } from './support/app-version.ts';
import { roleMainOverride } from './support/launcher.ts';
import { readLog } from './support/log-reader.ts';
import { startStack } from './support/stack.ts';
import { toolCallReply } from './support/upstream.ts';
import { E2E_TEST_TIMEOUT_MS } from './support/wait.ts';
import { requiredToolPath, requires } from '../test/support/required-tools.ts';

const COMPLIANCE_DIR = path.join(import.meta.dirname, '..', 'compliance', 'open-responses');
const BUN = requiredToolPath('bun');
const SUITE_ENTRY = path.join(COMPLIANCE_DIR, 'suite', 'bin', 'compliance-test.ts');
const SERVED = ['basic-response', 'assistant-phase', 'response-output-phase-schema', 'streaming-response', 'system-prompt', 'tool-calling', 'image-input', 'multi-turn', 'compact-response', 'compact-missing-model'] as const;
const NOT_SERVED = [
  'websocket-response',
  'websocket-sequential-responses',
  'websocket-continuation',
  'websocket-reconnect-store-false-recovery',
  'websocket-previous-response-not-found',
  'websocket-failed-continuation-evicts-cache',
  'websocket-compact-new-chain',
] as const;
const WEBSOCKET_REFUSED = 'WebSocket connection failed';
const TOTAL_TESTS = SERVED.length + NOT_SERVED.length;
const DEBUG_TOKEN = 'fake-open-responses-debug-token';
const MODEL = 'fake/system';

type SuiteResult = { id: string; name: string; status: 'passed' | 'failed' | 'skipped'; errors?: string[] };
type SuiteOutput = { summary: { passed: number; failed: number; skipped: number; total: number }; results: SuiteResult[] };

const runSuite = (baseUrl: string, cwd: string, env: Record<string, string>): Promise<{ output: SuiteOutput; exitCode: number | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn(BUN, ['run', SUITE_ENTRY, '--base-url', baseUrl, '--api-key', DEBUG_TOKEN, '--model', MODEL, '--json'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    registerE2eCleanup(() => void child.kill('SIGKILL'));
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => void (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => void (stderr += chunk));
    child.once('error', reject);
    child.once('close', (exitCode) => {
      try {
        resolve({ output: JSON.parse(stdout) as SuiteOutput, exitCode });
      } catch (error) {
        reject(new Error(`the compliance suite printed no JSON result (exit ${exitCode}): ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });

const debugPortOf = (logFile: string): number => {
  const port = readLog(logFile).find((entry) => entry.msg === 'gateway.debug_listener')?.['port'];
  if (typeof port !== 'number') throw new Error(`the ready gateway logged no debug listener port in ${logFile}`);
  return port;
};

describe('Open Responses compliance suite against the supervised gateway debug listener', () => {
  it(titleOf('open-responses-compliance'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    requires('bun');
    const home = await createE2eHome();
    const fake = await startFakeChatCompletions({
      scenario: 'tools-ok',
      imageInput: true,
      maxConcurrency: 8,
      socketPath: home.upstreamSocket,
      routes: [{ match: (body) => JSON.stringify(body).includes('weather like in San Francisco'), reply: toolCallReply('get_weather', { location: 'San Francisco, CA' }) }],
    });
    registerE2eCleanup(() => fake.close());
    const tokenFile = path.join(home.root, 'debug.token');
    fs.writeFileSync(tokenFile, `${DEBUG_TOKEN}\n`, { mode: 0o600 });
    await startStack({
      home,
      upstream: fake,
      settings: {
        ...modelSettings({
          models: [
            {
              adapter: 'chat-completions',
              provider: 'fake',
              id: 'system',
              socketPath: home.upstreamSocket,
              maxConcurrency: 8,
              capabilities: { contextWindow: 8192, maxOutputTokens: 1024, imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 }, parallelToolCalls: true },
            },
          ],
        }),
      },
      deps: {
        launcherOverrides: { gateway: roleMainOverride('gateway', SUPERVISOR_APP_VERSION, ['--debug-tcp-port=0', `--debug-tcp-token-file=${tokenFile}`]) },
      },
    });
    const port = debugPortOf(home.paths.logFiles.gateway);

    const { output, exitCode } = await runSuite(`http://127.0.0.1:${port}/v1`, home.root, { ...standInEnv('/usr/bin:/bin'), HOME: home.home, TMPDIR: home.sessionTmp });

    const idsWith = (status: SuiteResult['status']): string[] => output.results.filter((result) => result.status === status).map((result) => result.id).sort();
    expect(output.results.filter((result) => result.status !== 'passed' && !NOT_SERVED.some((id) => id === result.id))).toEqual([]);
    expect(idsWith('passed')).toEqual([...SERVED].sort());
    expect(idsWith('failed')).toEqual([...NOT_SERVED].sort());
    expect(output.results.filter((result) => result.status === 'failed').every((result) => result.errors?.some((error) => error.includes(WEBSOCKET_REFUSED)) === true)).toBe(true);
    expect(output.summary).toEqual({ passed: SERVED.length, failed: NOT_SERVED.length, skipped: 0, total: TOTAL_TESTS });
    expect(exitCode).toBe(1);
  });
});
